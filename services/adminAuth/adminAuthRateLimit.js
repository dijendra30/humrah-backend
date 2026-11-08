// services/adminAuth/adminAuthRateLimit.js — sliding-window limits stored in MongoDB.
// Insert-then-count makes concurrent requests race safely: each request counts the events at or
// before its own (ObjectId order), so at most `max` of a burst are admitted. Refused requests
// remove their own event, so a locked-out admin is not kept locked out by their own retries.
'use strict';

const AdminAuthRateEvent = require('../../models/AdminAuthRateEvent');
const { sha256 } = require('./adminAuthCrypto');

/**
 * @returns {Promise<{allowed:boolean, retryAfterSeconds:number}>}
 */
async function hit(scope, identity, { max, windowMs }) {
  const now = new Date();
  const key = sha256(`${scope}\u0000${identity}`);
  const since = new Date(now.getTime() - windowMs);
  const mine = await AdminAuthRateEvent.create({ key, at: now, expireAt: new Date(now.getTime() + windowMs + 60_000) });
  const count = await AdminAuthRateEvent.countDocuments({ key, at: { $gt: since }, _id: { $lte: mine._id } });
  if (count <= max) return { allowed: true, retryAfterSeconds: 0 };

  await AdminAuthRateEvent.deleteOne({ _id: mine._id });
  const oldest = await AdminAuthRateEvent.findOne({ key, at: { $gt: since } }).sort({ at: 1 }).lean();
  const retryMs = oldest ? oldest.at.getTime() + windowMs - now.getTime() : windowMs;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
}

module.exports = { hit };
