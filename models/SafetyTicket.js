// models/SafetyTicket.js
// Central model for the user-facing Safety Ticket System (Phase 2)
// Distinct from SafetyReport (admin workflow) — this is the user-initiated concern flow.

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// SafetyMessage sub-model  (embedded  OR  companion collection)
// Stored in separate collection for scalability but linked via ticketId.
// ─────────────────────────────────────────────────────────────────────────────
const safetyTicketSchema = new Schema(
    {
        // ── Identity ──────────────────────────────────────────────────────────
        ticketId: {
            type:     String,
            unique:   true,
            required: true,
            index:    true
        },

        // ── Reporter ──────────────────────────────────────────────────────────
        reporterId: {
            type:     Schema.Types.ObjectId,
            ref:      'User',
            required: true,
            index:    true
        },
        reporterName: {
            type:     String,
            required: true,
            trim:     true
        },

        // ── Subject of concern (optional — concerns can be general) ───────────
        reportedUserId: {
            type:    Schema.Types.ObjectId,
            ref:     'User',
            default: null
        },
        reportedUserName: {
            type:    String,
            default: '',
            trim:    true
        },

        // ── Concern details ───────────────────────────────────────────────────
        concernType: {
            type:     String,
            enum: [
                'felt_uncomfortable',
                'inappropriate_message',
                'felt_pressured_or_unsafe',
                'something_else'
            ],
            required: true
        },
        note: {
            type:      String,
            maxlength: 500,
            default:   '',
            trim:      true
        },

        // Snapshot of recent messages for Gemini context (never stored raw—objects only)
        chatContext: {
            type:    Array,
            default: []
        },

        // Optional booking context
        bookingContext: {
            type:    Schema.Types.Mixed,
            default: null
        },

        // ── Gemini risk analysis ──────────────────────────────────────────────
        riskLevel: {
            type:    String,
            enum:    ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
            default: 'LOW',
            index:   true
        },
        riskScore: {
            type:    Number,
            default: 0,
            min:     0,
            max:     100
        },
        geminiSummary: {
            type:    String,
            default: ''
        },
        detectedCategory: {
            type:    String,
            default: ''
        },
        geminiAnalyzed: {
            type:    Boolean,
            default: false
        },

        // ── Status lifecycle ──────────────────────────────────────────────────
        // OPEN                 → just submitted, awaiting review
        // UNDER_REVIEW         → safety team is reviewing
        // ASSISTANCE_REQUESTED → user pressed "Need Assistance", waiting for human
        // RESOLVED             → legacy or generic resolved state
        // RESOLVED_BY_USER     → user confirmed safe
        // RESOLVED_BY_TEAM     → safety team resolved
        // AUTO_RESOLVED        → automatically resolved due to inactivity
        // CLOSED               → admin/auto-closed
        status: {
            type:    String,
            enum:    ['OPEN', 'PENDING', 'UNDER_REVIEW', 'ASSISTANCE_REQUESTED', 'ESCALATED', 'RESOLVED', 'CLOSED', 'RESOLVED_BY_USER', 'RESOLVED_BY_ADMIN', 'AUTO_RESOLVED', 'RESOLVED_BY_TEAM'],
            default: 'OPEN',
            index:   true
        },

        // ── Admin Resolution ──────────────────────────────────────────────────
        resolvedBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },
        resolvedAt: {
            type: Date,
            default: null
        },
        resolutionNotes: {
            type: String,
            default: ''
        },

        // ── Telegram ──────────────────────────────────────────────────────────
        telegramNotified:  { type: Boolean, default: false },
        telegramMessageId: { type: String,  default: null  },
        emergencyNotified: { type: Boolean, default: false },

        // ── Location share ────────────────────────────────────────────────────
        sharedLocation: {
            latitude:  { type: Number, default: null },
            longitude: { type: Number, default: null },
            sharedAt:  { type: Date,   default: null }
        },

        // ── Auto Expiry ───────────────────────────────────────────────────────
        expiryWarningSent: { type: Boolean, default: false }
    },
    { timestamps: true }
);

// ── Compound indexes ──────────────────────────────────────────────────────────
safetyTicketSchema.index({ reporterId: 1, createdAt: -1 });
safetyTicketSchema.index({ status: 1, riskLevel: 1 });

// ── Ticket-ID generator (static) ─────────────────────────────────────────────
safetyTicketSchema.statics.generateId = function () {
    const now  = new Date();
    const yr   = now.getFullYear();
    const mo   = String(now.getMonth() + 1).padStart(2, '0');
    const dy   = String(now.getDate()).padStart(2, '0');
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `HST-${yr}${mo}${dy}-${rand}`;
};

module.exports = mongoose.model('SafetyTicket', safetyTicketSchema);
