// models/AdminLoginChallenge.js — one Admin Dashboard sign-in attempt (email OTP).
// The code itself is never stored: only an HMAC of it, keyed with a server secret.
// A challenge for an email that is not an authorised admin is a decoy (userId null, no email
// sent, can never verify) so responses look identical either way.
'use strict';

const mongoose = require('mongoose');

const STATUSES = ['PENDING', 'VERIFIED', 'SUPERSEDED', 'LOCKED', 'EXPIRED', 'DELIVERY_FAILED'];

const schema = new mongoose.Schema({
  challengeId: { type: String, required: true, unique: true },
  email:       { type: String, required: true },          // normalised admin identity that was entered
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  otpHash:     { type: String, required: true },
  otpIssuedAt: { type: Date, required: true },
  lastSentAt:  { type: Date, required: true },
  sendCount:   { type: Number, default: 1 },
  expiresAt:   { type: Date, required: true },          // code expiry
  attempts:    { type: Number, default: 0 },
  status:      { type: String, enum: STATUSES, default: 'PENDING' },
  closedAt:    { type: Date, default: null },
  ipHash:      { type: String, default: null },
  purgeAt:     { type: Date, required: true },          // TTL: rows disappear a day after expiry
}, { timestamps: true, collection: 'adminloginchallenges' });

schema.index({ email: 1, status: 1, otpIssuedAt: -1 });
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.AdminLoginChallenge || mongoose.model('AdminLoginChallenge', schema);
module.exports.STATUSES = STATUSES;
