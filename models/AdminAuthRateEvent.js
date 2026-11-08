// models/AdminAuthRateEvent.js — sliding-window counters for Admin Dashboard sign-in limits.
// Kept in MongoDB (shared by every backend instance) rather than process memory.
// `key` is a SHA-256 of scope + identity/IP, never the raw value.
'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key:      { type: String, required: true },
  at:       { type: Date, required: true },
  expireAt: { type: Date, required: true },
}, { versionKey: false, collection: 'adminauthrateevents' });

schema.index({ key: 1, at: -1 });
schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.AdminAuthRateEvent || mongoose.model('AdminAuthRateEvent', schema);
