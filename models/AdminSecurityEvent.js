// models/AdminSecurityEvent.js — Admin Dashboard authentication / access security log.
// Never holds codes, passwords, cookies, tokens or request bodies. Emails of people who are NOT
// authorised admins are stored only as a keyed hash plus a masked form. Readable by SUPER_ADMIN only.
'use strict';

const mongoose = require('mongoose');

const TYPES = [
  'OTP_REQUESTED', 'OTP_REQUEST_UNAUTHORISED', 'OTP_DELIVERED', 'OTP_DELIVERY_FAILED', 'OTP_RESENT',
  'OTP_RATE_LIMITED', 'OTP_INVALID', 'OTP_EXPIRED', 'OTP_REUSED', 'OTP_TOO_MANY_ATTEMPTS',
  'LOGIN_SUCCEEDED', 'LOGIN_DENIED', 'LOGOUT', 'SESSION_EXPIRED', 'ADMIN_ACCESS_REVOKED',
  'CSRF_REJECTED', 'FORBIDDEN_ADMIN_API_ACCESS', 'LEGACY_TOKEN_REJECTED', 'APP_TOKEN_REJECTED',
];

const schema = new mongoose.Schema({
  type:        { type: String, enum: TYPES, required: true },
  at:          { type: Date, default: Date.now },
  email:       { type: String, default: null },   // authorised admin identity only
  emailMasked: { type: String, default: null },
  emailHash:   { type: String, default: null },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  ipPrefix:    { type: String, default: null },   // IPv4 /24, IPv6 /48
  ipHash:      { type: String, default: null },
  userAgent:   { type: String, default: null },
  method:      { type: String, default: null },
  path:        { type: String, default: null },
  details:     { type: mongoose.Schema.Types.Mixed, default: undefined },
  expireAt:    { type: Date, required: true },    // retention (TTL)
}, { versionKey: false, collection: 'adminsecurityevents' });

schema.index({ at: -1 });
schema.index({ type: 1, at: -1 });
schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.AdminSecurityEvent || mongoose.model('AdminSecurityEvent', schema);
module.exports.TYPES = TYPES;
