// controllers/privateSafetyConcernController.js
// -----------------------------------------------------------------------------
// "Keep Private" safety concerns (models/PrivateSafetyConcern.js). Mounted under
// /api/safety-tickets (authenticated in server.js).
//
//   POST /private                     save one, privately, for a Sports session the caller is in
//   GET  /private[?sessionId=]        the caller's own private concerns (newest first)
//   POST /private/:concernId/send     the owner's explicit "Send for Review"
//
// PRIVATE MEANS PRIVATE. Saving creates no SafetyTicket, no Safety Team message, no
// Telegram alert, no push, no socket event. Every read and write is by { _id, userId }:
// someone else's concern answers 404, exactly like one that does not exist. The note
// is never logged (ids only) and never leaves these three routes.
//
// SENDING reuses the existing ticket flow unchanged: the request is handed to
// safetyTicketController.submitConcern, which validates, scores, creates the ticket and
// its messages, and alerts the Safety Team as for any other concern. The concern is
// claimed first with one conditional update (PRIVATE → SENT_FOR_REVIEW), so a double tap,
// a retry or two devices create at most one ticket; if the ticket cannot be created the
// claim is undone and the concern stays private.
// -----------------------------------------------------------------------------
'use strict';

const PrivateSafetyConcern = require('../models/PrivateSafetyConcern');
const SportsPlan = require('../models/SportsPlan');
const safetyTickets = require('./safetyTicketController');

const chat = () => require('../services/sportsChatService');

const isId = v => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const notFound = res => res.status(404).json({ success: false, code: 'CONCERN_NOT_FOUND', message: 'This concern is not available.' });

/** What the owner sees. Never sent anywhere else. */
function view(c) {
  return {
    id:              String(c._id),
    sessionId:       c.context && c.context.sessionId ? String(c.context.sessionId) : null,
    sportsPlanId:    c.context && c.context.sportsPlanId ? String(c.context.sportsPlanId) : null,
    concernType:     c.concernType,
    note:            c.note || '',
    state:           c.state,
    createdAt:       c.createdAt ? new Date(c.createdAt).toISOString() : null,
    sentForReviewAt: c.sentForReviewAt ? new Date(c.sentForReviewAt).toISOString() : null,
    ticketId:        c.ticketId || null,
  };
}

/** Runs the existing ticket handler with this body and returns { status, body } instead of replying. */
function submitThroughExistingFlow(req, body) {
  return new Promise((resolve, reject) => {
    const fake = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(safetyTickets.submitConcern({ ...req, body, userId: req.userId, user: req.user }, fake)).catch(reject);
  });
}

exports.savePrivate = async (req, res) => {
  try {
    const { sessionId, concernType } = req.body || {};
    const note = (req.body && req.body.note) == null ? '' : req.body.note;
    if (!PrivateSafetyConcern.CONCERN_TYPES.includes(concernType)) {
      return res.status(400).json({ success: false, message: 'Invalid concern type.' });
    }
    if (typeof note !== 'string' || note.length > 500) {
      return res.status(400).json({ success: false, message: 'Note exceeds 500 characters.' });
    }
    if (!isId(sessionId)) return res.status(400).json({ success: false, message: 'Invalid session.' });
    // Only from a Sports session the caller is in (the chat's own membership check).
    const access = await chat().loadForMember(req.user, sessionId);
    if (access.error) {
      const e = access.error;
      return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    }
    const concern = await PrivateSafetyConcern.create({
      userId:  req.userId,
      context: { kind: 'SPORTS_SESSION', sessionId: access.session._id, sportsPlanId: access.plan._id },
      concernType,
      note:    note.trim(),
    });
    console.log(`[PRIVATE_CONCERN_SAVED] concern=${concern._id} session=${access.session._id}`);   // ids only
    return res.status(201).json({ success: true, concern: view(concern) });
  } catch (err) {
    console.error('[PRIVATE_CONCERN] save failed:', err && err.name);
    return res.status(500).json({ success: false, message: 'Could not save your concern.' });
  }
};

exports.listPrivate = async (req, res) => {
  try {
    const filter = { userId: req.userId };
    const sessionId = req.query && req.query.sessionId;
    if (sessionId !== undefined && sessionId !== '') {
      if (!isId(String(sessionId))) return res.status(400).json({ success: false, message: 'Invalid session.' });
      filter['context.sessionId'] = String(sessionId);
    }
    const rows = await PrivateSafetyConcern.find(filter).sort({ createdAt: -1 }).limit(20).lean();
    return res.json({ success: true, concerns: rows.map(view) });
  } catch (err) {
    console.error('[PRIVATE_CONCERN] list failed:', err && err.name);
    return res.status(500).json({ success: false, message: 'Could not load your concerns.' });
  }
};

exports.sendPrivate = async (req, res) => {
  try {
    const { concernId } = req.params;
    if (!isId(concernId)) return notFound(res);
    const own = await PrivateSafetyConcern.findOne({ _id: concernId, userId: req.userId }).lean();
    if (!own) return notFound(res);
    if (own.state === 'SENT_FOR_REVIEW') return res.json({ success: true, alreadySent: true, concern: view(own) });

    // The claim: exactly one request moves it out of PRIVATE.
    const claimed = await PrivateSafetyConcern.findOneAndUpdate(
      { _id: concernId, userId: req.userId, state: 'PRIVATE' },
      { $set: { state: 'SENT_FOR_REVIEW', sentForReviewAt: new Date() } },
      { new: true },
    ).lean();
    if (!claimed) {
      const now = await PrivateSafetyConcern.findOne({ _id: concernId, userId: req.userId }).lean();
      return res.json({ success: true, alreadySent: true, concern: view(now || own) });
    }

    // The same Sports context the app attaches to a concern sent straight away.
    const plan = await SportsPlan.findById(claimed.context.sportsPlanId).select('sportType startTime').lean();
    const bookingContext = {
      type:         'SPORTS_SESSION',
      sessionId:    String(claimed.context.sessionId),
      sportsPlanId: String(claimed.context.sportsPlanId),
      sportType:    plan ? plan.sportType : null,
      startTime:    plan && plan.startTime ? new Date(plan.startTime).toISOString() : null,
    };
    const result = await submitThroughExistingFlow(req, { concernType: claimed.concernType, note: claimed.note || '', bookingContext });
    const ticketId = result && result.status === 201 && result.body && result.body.ticketId;
    if (!ticketId) {
      // Not sent: it goes back to private, unless something else already finished it.
      await PrivateSafetyConcern.updateOne(
        { _id: concernId, userId: req.userId, state: 'SENT_FOR_REVIEW', ticketId: null },
        { $set: { state: 'PRIVATE', sentForReviewAt: null } },
      );
      console.error(`[PRIVATE_CONCERN] send failed concern=${concernId} status=${result && result.status}`);
      return res.status(result && result.status >= 400 && result.status < 500 ? result.status : 502)
        .json({ success: false, message: 'Could not send your concern. It is still saved privately. Please try again.' });
    }
    await PrivateSafetyConcern.updateOne({ _id: concernId, userId: req.userId }, { $set: { ticketId } });
    console.log(`[PRIVATE_CONCERN_SENT] concern=${concernId} ticketId=${ticketId}`);   // ids only
    return res.status(201).json({ success: true, concern: view({ ...claimed, ticketId }), ticketId });
  } catch (err) {
    console.error('[PRIVATE_CONCERN] send error:', err && err.name);
    return res.status(500).json({ success: false, message: 'Could not send your concern. Please try again.' });
  }
};

module.exports._internal = { view, submitThroughExistingFlow };
