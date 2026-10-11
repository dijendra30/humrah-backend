// models/VoiceCallReservation.js
// One active call per person. A reservation's _id IS the user's id, so MongoDB's built-in
// _id uniqueness makes claiming a participant atomic: of two simultaneous claims exactly
// one insert succeeds. Lives in its own new collection — no index or migration on the
// existing voicecalls data.
//
// A hold is released lazily: when a claim finds an existing hold, it is cleared only if the
// call it points at is over (terminal, missing, or stale by VoiceCall's own rules). The TTL
// index below just garbage-collects old holds.
'use strict';

const mongoose  = require('mongoose');
const VoiceCall = require('./VoiceCall');

const ACTIVE_STATUSES    = ['RINGING', 'CONNECTING', 'CONNECTED'];
const HOLD_LIFETIME_MS   = 40 * 60 * 1000;  // beyond VoiceCall's longest stale limit (CONNECTED, 35 min)
const IN_FLIGHT_GRACE_MS = 15 * 1000;       // the call row is written right after both claims

const reservationSchema = new mongoose.Schema({
  _id:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },   // the participant
  callId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
}, { versionKey: false, collection: 'voicecallreservations' });

reservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Is this existing hold over? A stale-but-active call is ended the same way the busy
// check ends it, conditionally, so a call that moved on is never overwritten.
async function holdIsOver(hold) {
  const call = await VoiceCall.findById(hold.callId).select('status').lean();
  if (!call) return Date.now() - new Date(hold.createdAt).getTime() > IN_FLIGHT_GRACE_MS;
  if (!ACTIVE_STATUSES.includes(call.status)) return true;
  const ended = await VoiceCall.updateOne(
    { $and: [{ _id: hold.callId }, VoiceCall.staleActiveCallFilter()] },
    { $set: { status: 'ENDED', endedAt: new Date(), endReason: 'auto_timeout' } }
  );
  return ended.modifiedCount > 0;
}

/** Claims `userId` for `callId`. True when held for this call, false when they are busy. */
reservationSchema.statics.claim = async function(userId, callId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await this.create({ _id: userId, callId, expiresAt: new Date(Date.now() + HOLD_LIFETIME_MS) });
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

module.exports = mongoose.model('VoiceCallReservation', reservationSchema);
