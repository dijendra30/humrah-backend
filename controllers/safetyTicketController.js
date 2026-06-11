// controllers/safetyTicketController.js
// Orchestrator for the full Safety Ticket flow (Phase 2):
//   submit → Gemini risk → Telegram → bot chat message → return to Android
//
// AUDIT LOGGING TAGS (grep these in production logs):
//   SAFETY_TICKET_CREATED   SAFETY_REPORTED_USER_FOUND  SAFETY_CHAT_CREATED
//   SAFETY_MESSAGE_CREATED  SAFETY_MESSAGE_FETCHED       SAFETY_STATUS_OPENED
//   SAFETY_STATUS_FETCH_SUCCESS  SAFETY_STATUS_FETCH_FAILED  SAFETY_LIST_FETCHED
//   SAFETY_DUPLICATE_BLOCKED     SAFETY_ACTIVE_TICKET_CHECK

'use strict';

const SafetyTicket  = require('../models/SafetyTicket');
const SafetyMessage = require('../models/SafetyMessage');
const User          = require('../models/User');
const { analyzeRisk }            = require('../services/geminiService');
const {
    notifySafetyChannel,
    notifyEmergencyChannel,
    notifyLocationShared,
    notifyTicketResolved
} = require('../services/telegramService');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Bot welcome message text keyed by risk level — Step 6 */
function botWelcomeMessage(riskLevel) {
    switch (riskLevel) {
        case 'CRITICAL':
            return 'We are concerned about your safety. Are you currently safe right now?';
        case 'HIGH':
            return 'We noticed that your concern may require attention. Are you currently safe?';
        case 'MEDIUM':
            return 'Thank you.\n\nYour concern has been recorded and may be reviewed by Humrah Safety Team.';
        default: // LOW
            return 'Thank you.\n\nYour concern has been recorded. No immediate action is required at this time.';
    }
}

/** Ensure the requesting user owns the ticket */
async function assertOwner(ticketId, userId) {
    const ticket = await SafetyTicket.findOne({ ticketId });
    if (!ticket)                                            throw { status: 404, message: 'Ticket not found.' };
    if (ticket.reporterId.toString() !== userId.toString()) throw { status: 403, message: 'Access denied.' };
    return ticket;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/safety-tickets/check?reportedUserId=xxx
// Returns whether an OPEN ticket already exists for reporter+reportedUser.
// Used by Android pre-form guard to block duplicate reports.
// ─────────────────────────────────────────────────────────────────────────────
exports.checkActiveTicket = async (req, res) => {
    try {
        const { reportedUserId } = req.query;
        if (!reportedUserId) {
            return res.json({ success: true, exists: false });
        }

        const ticket = await SafetyTicket.findOne({
            reporterId:     req.userId,
            reportedUserId: reportedUserId,
            status:         { $in: ['OPEN', 'WAITING_FOR_SAFETY_TEAM', 'SAFETY_TEAM_CONNECTED', 'UNDER_REVIEW', 'ESCALATED', 'ASSISTANCE_REQUESTED'] }
        }).lean();

        if (ticket) {
            console.log(`[SAFETY_ACTIVE_TICKET_CHECK] reporterId=${req.userId} reportedUserId=${reportedUserId} found=true ticketId=${ticket.ticketId}`);
            return res.json({ success: true, exists: true, ticketId: ticket.ticketId, status: ticket.status });
        }

        console.log(`[SAFETY_ACTIVE_TICKET_CHECK] reporterId=${req.userId} reportedUserId=${reportedUserId} found=false`);
        return res.json({ success: true, exists: false });
    } catch (err) {
        console.error('[SafetyTicket] checkActiveTicket error:', err);
        return res.status(500).json({ success: false, message: 'Check failed.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/safety-tickets  — list caller's tickets (for chat list UI)
// ─────────────────────────────────────────────────────────────────────────────
exports.listTickets = async (req, res) => {
    try {
        const tickets = await SafetyTicket.find({ reporterId: req.userId })
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();

        // Attach latest message per ticket (single aggregate avoids N+1)
        const ticketIds = tickets.map(t => t._id);
        const latestMsgs = await SafetyMessage.aggregate([
            { $match: { ticketId: { $in: ticketIds } } },
            { $sort:  { createdAt: -1 } },
            { $group: {
                _id:       '$ticketId',
                content:   { $first: '$content' },
                createdAt: { $first: '$createdAt' }
            }}
        ]);
        const msgMap = {};
        latestMsgs.forEach(m => { msgMap[m._id.toString()] = { content: m.content, createdAt: m.createdAt }; });

        const result = tickets.map(t => ({
            ticketId:        t.ticketId,
            status:          t.status,
            riskLevel:       t.riskLevel,
            concernType:     t.concernType,
            reportedUserName: t.reportedUserName || '',
            createdAt:       t.createdAt,
            updatedAt:       t.updatedAt,
            latestMessage:   msgMap[t._id.toString()] || null
        }));

        console.log(`[SAFETY_LIST_FETCHED] reporterId=${req.userId} count=${result.length}`);

        return res.json({ success: true, tickets: result });
    } catch (err) {
        console.error('[SafetyTicket] listTickets error:', err);
        return res.status(500).json({ success: false, message: 'Could not load tickets.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets  — STEP 1 / 2 / 3 / 4 / 5 / 6
// ─────────────────────────────────────────────────────────────────────────────
exports.submitConcern = async (req, res) => {
    try {
        const {
            reportedUserId,
            reportedUserName = '',
            concernType,
            note            = '',
            chatContext     = [],
            bookingContext  = null
        } = req.body;

        // ── Validate ──────────────────────────────────────────────────────────
        const validTypes = ['felt_uncomfortable', 'inappropriate_message',
                            'felt_pressured_or_unsafe', 'something_else'];
        if (!validTypes.includes(concernType)) {
            return res.status(400).json({ success: false, message: 'Invalid concern type.' });
        }
        if (note && note.length > 500) {
            return res.status(400).json({ success: false, message: 'Note exceeds 500 characters.' });
        }

        // ── BUG #2 FIX: Duplicate OPEN ticket guard ───────────────────────────
        // A user may only have ONE OPEN ticket per reporter+reportedUser at a time.
        // If one already exists, return 409 with the existing ticket info so Android
        // can show the "Existing Safety Report Found" dialog instead of a new form.
        if (reportedUserId) {
            const existingTicket = await SafetyTicket.findOne({
                reporterId:     req.userId,
                reportedUserId: reportedUserId,
                status:         { $in: ['OPEN', 'WAITING_FOR_SAFETY_TEAM', 'SAFETY_TEAM_CONNECTED', 'UNDER_REVIEW', 'ESCALATED', 'ASSISTANCE_REQUESTED'] }
            }).lean();

            if (existingTicket) {
                console.log(`[SAFETY_DUPLICATE_BLOCKED] reporterId=${req.userId} reportedUserId=${reportedUserId} existingTicketId=${existingTicket.ticketId}`);
                return res.status(409).json({
                    success:   false,
                    duplicate: true,
                    message:   'An active safety report already exists for this user.',
                    ticketId:  existingTicket.ticketId,
                    status:    existingTicket.status
                });
            }
        }

        // ── Reporter name ─────────────────────────────────────────────────────
        const reporterName = req.user?.firstName
            ? `${req.user.firstName} ${req.user.lastName || ''}`.trim()
            : 'Unknown User';

        // ── AUDIT: reported user resolution ───────────────────────────────────
        if (reportedUserId) {
            console.log(`[SAFETY_REPORTED_USER_FOUND] reportedUserId=${reportedUserId} reportedUserName="${reportedUserName}" reporterId=${req.userId}`);
        } else {
            console.warn(`[SAFETY_REPORTED_USER_FOUND] reportedUserId=null — concern submitted without a target user. reporterId=${req.userId} concernType=${concernType}`);
        }

        // ── Gemini risk analysis — STEP 2 / 3 ────────────────────────────────
        const analysis = await analyzeRisk({ concernType, note, chatContext });

        // ── Create ticket — STEP 1 ────────────────────────────────────────────
        const ticketId = SafetyTicket.generateId();
        const ticket   = await SafetyTicket.create({
            ticketId,
            reporterId:       req.userId,
            reporterName,
            reportedUserId:   reportedUserId  || null,
            reportedUserName: reportedUserName || '',
            concernType,
            note:             note.trim(),
            chatContext:      chatContext.slice(0, 20),
            bookingContext,
            riskLevel:        analysis.riskLevel,
            riskScore:        analysis.riskScore,
            geminiSummary:    analysis.summary,
            detectedCategory: analysis.detectedCategory,
            geminiAnalyzed:   analysis.geminiAnalyzed,
            status:           'OPEN'
        });

        console.log(`[SAFETY_TICKET_CREATED] ticketId=${ticketId} reporterId=${req.userId} reportedUserId=${reportedUserId || 'null'} riskLevel=${analysis.riskLevel} riskScore=${analysis.riskScore}`);

        // ── Bot opening system message — STEP 5 ───────────────────────────────
        const sysMsg = await SafetyMessage.create({
            ticketId:   ticket._id,
            content:    `🛡 Safety Report Received\n\nYour concern has been successfully recorded and assigned to our Safety Team.\n\nTicket ID: ${ticketId}\nStatus: OPEN\n\nIf you need immediate help, use the action buttons below.`,
            isFromTeam: true,
            isSystem:   true
        });
        console.log(`[SAFETY_MESSAGE_CREATED] messageId=${sysMsg._id} ticketId=${ticketId} isSystem=true type=system-open`);

        // ── Bot welcome message — STEP 6 ─────────────────────────────────────
        const welcomeMsg = await SafetyMessage.create({
            ticketId:   ticket._id,
            content:    botWelcomeMessage(analysis.riskLevel),
            isFromTeam: true,
            isSystem:   false
        });
        console.log(`[SAFETY_MESSAGE_CREATED] messageId=${welcomeMsg._id} ticketId=${ticketId} isSystem=false type=welcome riskLevel=${analysis.riskLevel}`);

        // SAFETY_CHAT_CREATED: the safety conversation is established once both system messages
        // exist. This is the point at which the Android SafetyChatActivity can begin polling.
        console.log(`[SAFETY_CHAT_CREATED] ticketId=${ticketId} reporterId=${req.userId} reportedUserId=${reportedUserId || 'null'} messageCount=2 riskLevel=${analysis.riskLevel}`);

        // ── Telegram notification — STEP 4 (fire-and-forget) ─────────────────
        notifySafetyChannel({
            ticketId,
            reporterId:       req.userId.toString(),
            reporterName,
            reportedUserId:   reportedUserId  || 'N/A',
            reportedUserName: reportedUserName || 'Unknown',
            concernType,
            note,
            geminiSummary:    analysis.summary,
            detectedCategory: analysis.detectedCategory,
            riskLevel:        analysis.riskLevel,
            riskScore:        analysis.riskScore,
            createdAt:        ticket.createdAt
        }).then(msgId => {
            if (msgId) SafetyTicket.updateOne({ _id: ticket._id }, { telegramNotified: true, telegramMessageId: msgId }).exec();
        }).catch(err => console.error('[Telegram] Safety channel notify failed:', err.message));

        // ── Response ──────────────────────────────────────────────────────────
        return res.status(201).json({
            success:          true,
            message:          'Safety concern recorded.',
            ticketId,
            riskLevel:        analysis.riskLevel,
            riskScore:        analysis.riskScore,
            geminiSummary:    analysis.summary,
            detectedCategory: analysis.detectedCategory,
            status:           'OPEN'
        });
    } catch (err) {
        console.error('[SafetyTicket] submitConcern error:', err);
        return res.status(500).json({ success: false, message: 'Could not save your concern.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/safety-tickets/:ticketId
// ─────────────────────────────────────────────────────────────────────────────
exports.getTicket = async (req, res) => {
    try {
        console.log(`[SAFETY_STATUS_OPENED] ticketId=${req.params.ticketId} reporterId=${req.userId}`);

        const ticket = await assertOwner(req.params.ticketId, req.userId);

        console.log(`[SAFETY_STATUS_FETCH_SUCCESS] ticketId=${ticket.ticketId} status=${ticket.status} riskLevel=${ticket.riskLevel} reporterId=${req.userId} reportedUserId=${ticket.reportedUserId || 'null'}`);

        return res.json({
            success: true,
            ticket: {
                ticketId:         ticket.ticketId,
                status:           ticket.status,
                riskLevel:        ticket.riskLevel,
                riskScore:        ticket.riskScore,
                concernType:      ticket.concernType,
                note:             ticket.note,
                geminiSummary:    ticket.geminiSummary,
                detectedCategory: ticket.detectedCategory,
                reportedUserName: ticket.reportedUserName || '',
                createdAt:        ticket.createdAt,
                updatedAt:        ticket.updatedAt
            }
        });
    } catch (err) {
        console.error(`[SAFETY_STATUS_FETCH_FAILED] ticketId=${req.params.ticketId} reporterId=${req.userId} error=${err.message}`);
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        return res.status(500).json({ success: false, message: 'Could not load ticket.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/safety-tickets/:ticketId/messages
// ─────────────────────────────────────────────────────────────────────────────
exports.getMessages = async (req, res) => {
    try {
        const ticket   = await assertOwner(req.params.ticketId, req.userId);
        const messages = await SafetyMessage.find({ ticketId: ticket._id })
            .sort({ createdAt: 1 })
            .limit(200)
            .lean();

        console.log(`[SAFETY_MESSAGE_FETCHED] ticketId=${ticket.ticketId} reporterId=${req.userId} count=${messages.length}`);

        return res.json({
            success:  true,
            messages: messages.map(m => ({
                _id:        m._id.toString(),
                content:    m.content,
                isFromTeam: m.isFromTeam,
                isSystem:   m.isSystem,
                createdAt:  m.createdAt
            }))
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[SafetyTicket] getMessages error:', err);
        return res.status(500).json({ success: false, message: 'Could not load messages.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets/:ticketId/messages
// ─────────────────────────────────────────────────────────────────────────────
exports.sendMessage = async (req, res) => {
    try {
        const ticket = await assertOwner(req.params.ticketId, req.userId);

        if (ticket.status === 'CLOSED' || ticket.status === 'RESOLVED' ||
            ticket.status === 'RESOLVED_BY_USER' || ticket.status === 'RESOLVED_BY_TEAM' ||
            ticket.status === 'AUTO_RESOLVED') {
            return res.status(400).json({ success: false, message: 'Cannot message a closed ticket.' });
        }

        const { content } = req.body;
        if (!content || content.trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Message content is required.' });
        }

        const msg = await SafetyMessage.create({
            ticketId:   ticket._id,
            senderId:   req.userId,
            content:    content.trim().substring(0, 5000),
            isFromTeam: false,
            isSystem:   false
        });

        console.log(`[SAFETY_MESSAGE_CREATED] messageId=${msg._id} ticketId=${ticket.ticketId} senderId=${req.userId} isFromTeam=false`);

        return res.status(201).json({
            success: true,
            message: {
                _id:        msg._id.toString(),
                content:    msg.content,
                isFromTeam: false,
                isSystem:   false,
                createdAt:  msg.createdAt
            }
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[SafetyTicket] sendMessage error:', err);
        return res.status(500).json({ success: false, message: 'Could not send message.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets/:ticketId/i-am-safe  — STEP 8
// ─────────────────────────────────────────────────────────────────────────────
exports.markIAmSafe = async (req, res) => {
    try {
        const ticket = await assertOwner(req.params.ticketId, req.userId);

        ticket.status    = 'RESOLVED_BY_USER';
        ticket.updatedAt = new Date();
        await ticket.save();

        const resolvedMsg = await SafetyMessage.create({
            ticketId:   ticket._id,
            content:    '✅ User confirmed they are safe.\n\nThis ticket has been marked as resolved.',
            isFromTeam: true,
            isSystem:   true
        });
        console.log(`[SAFETY_MESSAGE_CREATED] messageId=${resolvedMsg._id} ticketId=${ticket.ticketId} type=resolved`);

        notifyTicketResolved(ticket.ticketId, ticket.riskLevel)
            .catch(err => console.error('[Telegram] Resolve notify failed:', err.message));

        return res.json({ success: true, status: 'RESOLVED_BY_USER', message: 'Ticket resolved.' });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[SafetyTicket] markIAmSafe error:', err);
        return res.status(500).json({ success: false, message: 'Could not resolve ticket.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets/:ticketId/need-assistance  — STEP 9 / 10 / 11
// ─────────────────────────────────────────────────────────────────────────────
exports.requestAssistance = async (req, res) => {
    try {
        const ticket = await assertOwner(req.params.ticketId, req.userId);

        ticket.status    = 'WAITING_FOR_SAFETY_TEAM';
        ticket.updatedAt = new Date();
        await ticket.save();

        const assistMsg = await SafetyMessage.create({
            ticketId:   ticket._id,
            content:    '🚨 User requested immediate assistance.\n\nWe are connecting you to a Humrah Safety Team member. Please stay in this conversation.',
            isFromTeam: true,
            isSystem:   true
        });
        console.log(`[SAFETY_MESSAGE_CREATED] messageId=${assistMsg._id} ticketId=${ticket.ticketId} type=need-assistance`);

        notifyEmergencyChannel({
            ticketId:     ticket.ticketId,
            reporterName: ticket.reporterName,
            reporterId:   ticket.reporterId.toString(),
            riskLevel:    ticket.riskLevel
        }).then(msgId => {
            if (msgId) SafetyTicket.updateOne({ _id: ticket._id }, { emergencyNotified: true }).exec();
        }).catch(err => console.error('[Telegram] Emergency notify failed:', err.message));

        return res.json({ success: true, status: 'WAITING_FOR_SAFETY_TEAM', message: 'Assistance requested.' });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[SafetyTicket] requestAssistance error:', err);
        return res.status(500).json({ success: false, message: 'Could not request assistance.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets/:ticketId/share-location  — STEP 12
// ─────────────────────────────────────────────────────────────────────────────
exports.shareLocation = async (req, res) => {
    try {
        const ticket = await assertOwner(req.params.ticketId, req.userId);

        const { latitude, longitude } = req.body;
        if (latitude == null || longitude == null) {
            return res.status(400).json({ success: false, message: 'latitude and longitude are required.' });
        }

        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);
        if (isNaN(lat) || isNaN(lng)) {
            return res.status(400).json({ success: false, message: 'Invalid coordinates.' });
        }

        ticket.sharedLocation = { latitude: lat, longitude: lng, sharedAt: new Date() };
        ticket.updatedAt      = new Date();
        await ticket.save();

        const locMsg = await SafetyMessage.create({
            ticketId:   ticket._id,
            content:    'Location shared with Humrah Safety Team.',
            isFromTeam: true,
            isSystem:   true
        });
        console.log(`[SAFETY_MESSAGE_CREATED] messageId=${locMsg._id} ticketId=${ticket.ticketId} type=location-shared lat=${lat} lng=${lng}`);

        notifyLocationShared({
            ticketId:     ticket.ticketId,
            reporterName: ticket.reporterName,
            reporterId:   ticket.reporterId.toString()
        }, lat, lng).catch(err => console.error('[Telegram] Location notify failed:', err.message));

        return res.json({ success: true, message: 'Location shared.' });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, message: err.message });
        console.error('[SafetyTicket] shareLocation error:', err);
        return res.status(500).json({ success: false, message: 'Could not share location.' });
    }
};
