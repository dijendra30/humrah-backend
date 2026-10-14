// models/VoiceCallReservation.js
// One active call per person. A reservation's _id IS the user's id, so MongoDB's built-in
// _id uniqueness makes claiming a participant atomic: of two simultaneous claims exactly
// one insert succeeds. Lives in its own new collection — no index or migration on the
// existing voicecalls data.
//
// A hold is released lazily: when a claim finds an existing hold, it is cleared only if the
// call it points at is over (terminal, missing, or stale by VoiceCall's own rules). The TTL
// index below just garbage-collects old holds.
//
// Shared with Quick Connect: a hold with kind 'qc' points at a QuickConnectSession instead of
// a VoiceCall. A hold WITHOUT kind is an Agora VoiceCall hold exactly as before — existing
// documents need no migration and voice claims never write the field.
'use strict';

const mongoose  = require('mongoose');
const VoiceCall = require('./VoiceCall');

const ACTIVE_STATUSES    = ['RINGING', 'CONNECTING', 'CONNECTED'];
const HOLD_LIFETIME_MS   = 40 * 60 * 1000;  // beyond VoiceCall's longest stale limit (CONNECTED, 35 min)
const IN_FLIGHT_GRACE_MS = 15 * 1000;       // the call row is written right after both claims
const QC_KIND            = 'qc';

const reservationSchema = new mongoose.Schema({
  _id:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },   // the participant
  callId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  kind:      { type: String, enum: [QC_KIND] },                       // absent = Agora VoiceCall
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
}, { versionKey: false, collection: 'voicecallreservations' });

reservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// A Quick Connect hold is over when its session is terminal, missing after the in-flight
// grace, or stale by the session's own rules (then ended here, conditionally).
async function qcHoldIsOver(hold) {
  const QuickConnectSession = require('./QuickConnectSession');
  const session = await QuickConnectSession.findById(hold.callId).select('status').lean();
  if (!session) return Date.now() - new Date(hold.createdAt).getTime() > IN_FLIGHT_GRACE_MS;
  if (!QuickConnectSession.ACTIVE_STATUSES.includes(session.status)) return true;
  const ended = await QuickConnectSession.updateOne(
    { $and: [{ _id: hold.callId }, QuickConnectSession.staleActiveFilter()] },
    { $set: { status: 'ENDED', endedAt: new Date(), endReason: 'stale_cleanup' } }
  );
  return ended.modifiedCount > 0;
}

// Is this existing hold over? A stale-but-active call is ended the same way the busy
// check ends it, conditionally, so a call that moved on is never overwritten.
async function holdIsOver(hold) {
  if (hold.kind === QC_KIND) return qcHoldIsOver(hold);
  const call = await VoiceCall.findById(hold.callId).select('status').lean();
  if (!call) return Date.now() - new Date(hold.createdAt).getTime() > IN_FLIGHT_GRACE_MS;
  if (!ACTIVE_STATUSES.includes(call.status)) return true;
  const ended = await VoiceCall.updateOne(
    { $and: [{ _id: hold.callId }, VoiceCall.staleActiveCallFilter()] },
    { $set: { status: 'ENDED', endedAt: new Date(), endReason: 'auto_timeout' } }
  );
  return ended.modifiedCount > 0;
}

/**
 * Claims `userId` for `callId`. True when held for this call, false when they are busy.
 * `kind` is 'qc' for a Quick Connect session; omitted for an Agora VoiceCall (unchanged).
 */
reservationSchema.statics.claim = async function(userId, callId, kind) {
  const doc = { _id: userId, callId };
  if (kind === QC_KIND) doc.kind = QC_KIND;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await this.create({ ...doc, expiresAt: new Date(Date.now() + HOLD_LIFETIME_MS) });
      return true;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
    const hold = await this.findById(userId).lean();
    if (!hold) continue;                                       // released meanwhile — try again
    if (String(hold.callId) === String(callId)) return true;
    if (!(await holdIsOver(hold))) return false;
    await this.deleteOne({ _id: userId, callId: hold.callId });  // only that exact stale hold
  }
  return false;
};

/** Releases `userId` only if still held for `callId`. */
reservationSchema.statics.release = function(userId, callId) {
  return this.deleteOne({ _id: userId, callId });
};

/**
 * Read-only busy check for eligibility: true while `userId` holds a reservation that is not
 * over. `exceptCallId` ignores the caller's own session. The atomic claim remains the
 * guarantee; this only lets an eligibility answer say "busy" early.
 */
reservationSchema.statics.isHeld = async function(userId, exceptCallId) {
  const hold = await this.findById(userId).lean();
  if (!hold) return false;
  if (exceptCallId && String(hold.callId) === String(exceptCallId)) return false;
  return !(await holdIsOver(hold));
};

reservationSchema.statics.QC_KIND = QC_KIND;

module.exports = mongoose.model('VoiceCallReservation', reservationSchema);
