// models/AdminSession.js — server-side Admin Dashboard session.
// The browser holds a random 256-bit id in an HttpOnly cookie; only its SHA-256 is stored here,
// so a database read never yields a usable cookie.
'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  idHash:     { type: String, required: true, unique: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email:      { type: String, required: true },
  role:       { type: String, required: true },
  tv:         { type: Number, default: 0 },          // User.tokenVersion at sign-in (logout-all / password change revokes)
  lastSeenAt: { type: Date, required: true },
  expiresAt:  { type: Date, required: true },        // absolute lifetime
  idleMs:     { type: Number, required: true },
  revokedAt:  { type: Date, default: null },
  revokeReason: { type: String, default: null },
  ipPrefix:   { type: String, default: null },
  userAgent:  { type: String, default: null },
  purgeAt:    { type: Date, required: true },        // TTL
}, { timestamps: true, collection: 'adminsessions' });

schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.AdminSession || mongoose.model('AdminSession', schema);
