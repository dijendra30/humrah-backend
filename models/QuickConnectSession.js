// models/QuickConnectSession.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 4): the minimum lifecycle record a Quick Connect call needs
// so the SHARED one-call-per-person reservation (models/VoiceCallReservation.js,
// kind 'qc') can tell a live session from an abandoned one.
//
// Phase 4 adds no user-facing way to create a session — matching is a later phase.
// Sessions are created by server code only (and by tests).
//
// Separate from VoiceCall on purpose: VoiceCall is booking-centric (bookingId and
// an Agora channel are required) and its meaning must not change.
//
// Ending is always a CONDITIONAL write on the session still being active, so a
// session that already ended is never rewritten (see services/quickConnect/sessions.js).
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const ACTIVE_STATUSES   = ['ACCEPTED', 'CONNECTING', 'CONNECTED'];
const TERMINAL_STATUSES = ['ENDED', 'EXPIRED', 'CANCELLED', 'FAILED'];
const END_REASONS = [
  'hangup', 'cancelled', 'setup_failed', 'setup_timeout', 'max_duration',
  'disconnect_timeout', 'stale_cleanup', 'session_replaced', 'moderation', 'system_error'
];

const MAX_DURATION_MS   = 30 * 60 * 1000;   // agreed beta maximum (Phase 3D §5)
const SETUP_STALE_MS    = 2 * 60 * 1000;    // ACCEPTED/CONNECTING must reach CONNECTED within 2 min
const END_GRACE_MS      = 60 * 1000;        // CONNECTED past endsAt + grace is abandoned

const sessionSchema = new mongoose.Schema({
  // Exactly two distinct users, stored in sorted order.
  participants: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    required: true,
    validate: {
      validator: v => Array.isArray(v) && v.length === 2 && String(v[0]) < String(v[1]),
      message: 'participants must be two distinct users in sorted order'
    }
  },
  status:      { type: String, enum: [...ACTIVE_STATUSES, ...TERMINAL_STATUSES], required: true, default: 'ACCEPTED' },
  acceptedAt:  { type: Date, required: true, default: Date.now },
  connectedAt: { type: Date, default: null },
  endsAt:      { type: Date, required: true },     // server-enforced maximum duration
  endedAt:     { type: Date, default: null },
  endReason:   { type: String, enum: [...END_REASONS, null], default: null },
  endedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true, versionKey: false, collection: 'quickconnectsessions' });

sessionSchema.index({ participants: 1, status: 1 });
sessionSchema.index({ status: 1, endsAt: 1 });
// Retention: session metadata (no content, no media) is deleted 30 days after creation,
// matching VoiceCall's TTL.
sessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

/**
 * Active sessions that are stale by their own state. Used as the FILTER of the
 * cleanup write itself, so a session that moved on in the meantime is untouched.
 */
function staleActiveFilter(now = Date.now()) {
  const setupCutoff = new Date(now - SETUP_STALE_MS);
  return {
    $or: [
      { status: { $in: ['ACCEPTED', 'CONNECTING'] }, acceptedAt: { $lt: setupCutoff } },
      { status: { $in: ACTIVE_STATUSES }, endsAt: { $lt: new Date(now - END_GRACE_MS) } }
    ]
  };
}

sessionSchema.statics.staleActiveFilter = staleActiveFilter;
sessionSchema.statics.ACTIVE_STATUSES = ACTIVE_STATUSES;
sessionSchema.statics.TERMINAL_STATUSES = TERMINAL_STATUSES;
sessionSchema.statics.END_REASONS = END_REASONS;
sessionSchema.statics.MAX_DURATION_MS = MAX_DURATION_MS;

module.exports = mongoose.models.QuickConnectSession || mongoose.model('QuickConnectSession', sessionSchema);
