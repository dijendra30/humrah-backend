// services/engagement/control.js
// -----------------------------------------------------------------------------
// Phase 3: the database switches behind the dashboard's Emergency stop and AI pause
// (models/EngagementControl.js).
//
// Reads are uncached on purpose: the worker checks before every planner batch, before
// every queue claim and again right before every FCM send, so a stop takes effect within
// one in-flight send on every instance. Each write is one atomic update of the single
// 'global' document; the change, the admin and the reason are kept on it and in AuditLog.
// If the switch cannot be read, the worker treats delivery as STOPPED (fail closed).
// -----------------------------------------------------------------------------
'use strict';

const EngagementControl = require('../../models/EngagementControl');
const { audit } = require('./audit');
const log = require('./log');

const ID = 'global';

async function get() {
  return (await EngagementControl.findById(ID).lean()) || { _id: ID, deliveryStopped: false, aiPaused: false, history: [] };
}

/** Fail closed: an unreadable switch counts as stopped. */
async function isDeliveryStopped() {
  try { return (await get()).deliveryStopped === true; }
  catch (err) { log.error('control_read_failed', { err: log.errTag(err) }); return true; }
}

async function isAiPaused() {
  try { return (await get()).aiPaused === true; }
  catch (err) { log.error('control_read_failed', { err: log.errTag(err) }); return true; }
}

const cleanReason = r => (typeof r === 'string' && r.trim() ? r.trim().slice(0, 300) : null);

/**
 * @param {'delivery'|'ai'} which
 * @param {boolean} on   true = stop/pause, false = resume
 * @returns {Promise<{ok:boolean, code?:string, control?:object}>}
 */
async function set(which, on, admin, { reason, req } = {}) {
  const field = which === 'delivery' ? 'deliveryStopped' : 'aiPaused';
  const action = which === 'delivery' ? (on ? 'DELIVERY_STOPPED' : 'DELIVERY_RESUMED') : (on ? 'AI_PAUSED' : 'AI_RESUMED');
  const now = new Date();
  const set_ = { [field]: on };
  if (which === 'delivery') Object.assign(set_, on ? { deliveryStoppedAt: now, deliveryStoppedBy: admin._id, deliveryStopReason: cleanReason(reason) } : { deliveryStoppedAt: null, deliveryStoppedBy: null, deliveryStopReason: null });
  else Object.assign(set_, on ? { aiPausedAt: now, aiPausedBy: admin._id } : { aiPausedAt: null, aiPausedBy: null });
  // Conditional on the current value: two admins pressing the same button change it once.
  let updated;
  try {
    updated = await EngagementControl.findOneAndUpdate(
      { _id: ID, [field]: { $ne: on } },
      { $set: set_, $push: { history: { $each: [{ action, by: admin._id, byEmail: admin.email || null, reason: cleanReason(reason), at: now }], $slice: -50 } } },
      // Only a stop/pause may create the document; resuming something never stopped is a no-op.
      { upsert: on, new: true }
    ).lean();
    if (!updated) return { ok: false, code: 'ALREADY_OFF', control: await get() };
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, code: on ? 'ALREADY_ON' : 'ALREADY_OFF', control: await get() };
    throw err;
  }
  log.warn('control_changed', { action });
  await audit(admin, `ENGAGEMENT_${action}`, 'ENGAGEMENT_CONTROL', undefined, { reason: cleanReason(reason), req, after: { [field]: on } });
  return { ok: true, control: updated };
}

module.exports = { get, isDeliveryStopped, isAiPaused, set, ID };
