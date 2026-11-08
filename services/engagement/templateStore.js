// services/engagement/templateStore.js
// -----------------------------------------------------------------------------
// Template repository (Phase 2). The only code that writes EngagementTemplate.
//
// Lifecycle transitions are single conditional updates on { _id, status: from } —
// two admins acting at once cannot both succeed, and nothing can skip a step:
//   approve   DRAFT → APPROVED          (re-validated against the current rules first)
//   reject    DRAFT|APPROVED → REJECTED
//   activate  APPROVED|PAUSED → ACTIVE  (the ONLY status the worker ever loads)
//   pause     ACTIVE → PAUSED
//   archive   DRAFT|APPROVED|ACTIVE|PAUSED|REJECTED → ARCHIVED (terminal)
// Content is never edited in place: revise() validates new copy and stores it as the
// next VERSION (DRAFT) under the same templateId; the old version keeps its status
// and text, and queued notifications keep the text they were rendered with.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const EngagementTemplate = require('../../models/EngagementTemplate');
const EngagementNotification = require('../../models/EngagementNotification');
const validator = require('./ai/validator');
const aiConfig = require('../../config/engagementAiConfig');
const log = require('./log');

const TRANSITIONS = Object.freeze({
  approve:  { from: ['DRAFT'], to: 'APPROVED' },
  reject:   { from: ['DRAFT', 'APPROVED'], to: 'REJECTED' },
  activate: { from: ['APPROVED', 'PAUSED'], to: 'ACTIVE' },
  pause:    { from: ['ACTIVE'], to: 'PAUSED' },
  archive:  { from: ['DRAFT', 'APPROVED', 'ACTIVE', 'PAUSED', 'REJECTED'], to: 'ARCHIVED' },
});

const newTemplateId = category => `ai.${category.toLowerCase()}.${crypto.randomBytes(5).toString('hex')}`;

/** Store validated AI candidates. Duplicate-key races become DUPLICATE rejections. */
async function createFromBatch(accepted, { request, batchId, provider, model, now = new Date() }) {
  const policy = aiConfig.get().approvalPolicy;
  const status = policy === 'auto_approve' ? 'APPROVED' : 'DRAFT';
  const stored = [];
  const rejected = [];
  for (const a of accepted) {
    try {
      const doc = await EngagementTemplate.create({
        templateId: newTemplateId(request.category), version: 1,
        category: request.category, purpose: request.purpose, language: request.language, tone: request.tone,
        title: a.title, body: a.body, variables: a.variables, contentHash: a.contentHash,
        validationVersion: validator.VALIDATION_VERSION,
        source: 'AI', provider, model, generationBatchId: batchId,
        status, approvedAt: status === 'APPROVED' ? now : null,
      });
      stored.push(doc._id);
    } catch (err) {
      if (err && err.code === 11000) rejected.push({ code: 'DUPLICATE' });
      else throw err;
    }
  }
  return { stored, rejected, status };
}

/** Generic copy already stored for a category + language (for dedupe and the "avoid" list). */
async function existingFor(category, language, limit = 300) {
  return EngagementTemplate.find({ category, language }).sort({ createdAt: -1 }).limit(limit)
    .select('title body contentHash status').lean();
}

async function transition(id, action, adminId, { reason } = {}) {
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, code: 'UNKNOWN_ACTION' };
  if (!mongoose.isValidObjectId(id)) return { ok: false, code: 'NOT_FOUND' };
  const current = await EngagementTemplate.findById(id).lean();
  if (!current) return { ok: false, code: 'NOT_FOUND' };
  if (!t.from.includes(current.status)) return { ok: false, code: 'INVALID_TRANSITION', status: current.status };

  if (action === 'approve') {
    // Rules may have tightened since generation: re-check before anything can go live.
    const v = validator.validateTemplate({ title: current.title, body: current.body }, {
      category: current.category, purpose: current.purpose, language: current.language, tone: current.tone,
      titleMax: validator.HARD_TITLE_MAX, bodyMax: validator.HARD_BODY_MAX,
    });
    if (!v.ok) return { ok: false, code: 'FAILS_VALIDATION', reason: v.code };
  }

  const now = new Date();
  const set = { status: t.to, statusChangedBy: adminId || null };
  if (action === 'approve') Object.assign(set, { approvedAt: now, approvedBy: adminId || null });
  if (action === 'reject') Object.assign(set, { rejectedAt: now, rejectedBy: adminId || null, rejectionReason: typeof reason === 'string' ? reason.slice(0, 200) : null });
  if (action === 'activate') Object.assign(set, { activatedAt: now });
  if (action === 'pause') Object.assign(set, { pausedAt: now });
  if (action === 'archive') Object.assign(set, { archivedAt: now });
  const updated = await EngagementTemplate.findOneAndUpdate({ _id: id, status: current.status }, { $set: set }, { new: true }).lean();
  if (!updated) return { ok: false, code: 'CONFLICT' };
  log.info('template_status_changed', { templateId: updated.templateId, version: updated.version, from: current.status, to: t.to });
  return { ok: true, template: updated };
}

/** New version of an existing template (admin edit). Returns the new DRAFT. */
async function revise(id, input, adminId) {
  if (!mongoose.isValidObjectId(id)) return { ok: false, code: 'NOT_FOUND' };
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['title', 'body'].includes(k))) return { ok: false, code: 'INVALID_REQUEST' };
  const base = await EngagementTemplate.findById(id).lean();
  if (!base) return { ok: false, code: 'NOT_FOUND' };
  if (base.status === 'ARCHIVED') return { ok: false, code: 'INVALID_TRANSITION', status: base.status };
  const v = validator.validateTemplate({ title: input.title, body: input.body }, {
    category: base.category, purpose: base.purpose, language: base.language, tone: base.tone,
    titleMax: validator.HARD_TITLE_MAX, bodyMax: validator.HARD_BODY_MAX,
  });
  if (!v.ok) return { ok: false, code: 'FAILS_VALIDATION', reason: v.code };
  const latest = await EngagementTemplate.findOne({ templateId: base.templateId }).sort({ version: -1 }).select('version').lean();
  try {
    const doc = await EngagementTemplate.create({
      templateId: base.templateId, version: latest.version + 1, parentVersion: base.version,
      category: base.category, purpose: base.purpose, language: base.language, tone: base.tone,
      title: v.value.title, body: v.value.body, variables: v.value.variables, contentHash: v.value.contentHash,
      validationVersion: validator.VALIDATION_VERSION, source: 'ADMIN', provider: null, model: null,
      generationBatchId: base.generationBatchId || null, status: 'DRAFT', createdBy: adminId || null,
    });
    return { ok: true, template: doc.toObject() };
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, code: 'DUPLICATE' };
    throw err;
  }
}

/** ACTIVE templates only — loaded once per planner run, never per user. */
async function loadActiveTemplates() {
  return EngagementTemplate.find({ status: 'ACTIVE' })
    .select('templateId version category purpose language tone title body variables source').limit(2000).lean();
}

/** Usage = a notification was QUEUED with this version (sending/opening are Phase 1 analytics). */
async function recordUsage(templateDocId, now = new Date()) {
  if (!templateDocId) return;
  await EngagementTemplate.updateOne({ _id: templateDocId }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: now } });
}

/** Aggregate Phase 1 analytics per template version into performanceMetadata. */
async function refreshPerformance(now = new Date()) {
  const rows = await EngagementNotification.aggregate([
    { $match: { templateKey: { $regex: '^ai\\.' } } },
    { $group: {
      _id: { k: '$templateKey', v: '$templateVersion' },
      queued: { $sum: 1 },
      fcmAccepted: { $sum: { $cond: [{ $ifNull: ['$fcmAcceptedAt', false] }, 1, 0] } },
      opened: { $sum: { $cond: [{ $ifNull: ['$openedAt', false] }, 1, 0] } },
      featureOpened: { $sum: { $cond: [{ $ifNull: ['$featureOpenedAt', false] }, 1, 0] } },
    } },
  ]);
  for (const r of rows) {
    await EngagementTemplate.updateOne({ templateId: r._id.k, version: r._id.v }, { $set: {
      'performanceMetadata.queued': r.queued, 'performanceMetadata.fcmAccepted': r.fcmAccepted,
      'performanceMetadata.opened': r.opened, 'performanceMetadata.featureOpened': r.featureOpened,
      'performanceMetadata.refreshedAt': now,
    } });
  }
  return rows.length;
}

const LIST_FILTERS = { status: EngagementTemplate.STATUSES, category: null, language: aiConfig.LANGUAGES, purpose: null, tone: aiConfig.TONES, provider: aiConfig.PROVIDERS };
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ymd = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) ? Date.parse(`${s}T00:00:00Z`) - 5.5 * 3600 * 1000 : null);
/** Admin listing with strict filters and bounded pages. */
async function list(query = {}) {
  const filter = {};
  for (const [k, allowed] of Object.entries(LIST_FILTERS)) {
    const v = query[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !/^[A-Za-z_]{1,40}$/.test(v)) return { ok: false, code: 'INVALID_FILTER', field: k };
    const val = k === 'category' || k === 'status' ? v.toUpperCase() : (k === 'tone' || k === 'provider' ? v.toLowerCase() : v);
    if (allowed && !allowed.includes(val)) return { ok: false, code: 'INVALID_FILTER', field: k };
    filter[k] = val;
  }
  // Phase 3: text search in the copy (escaped, bounded) and a created-date range (Asia/Kolkata days).
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || query.q.length > 60) return { ok: false, code: 'INVALID_FILTER', field: 'q' };
    const q = query.q.trim();
    if (q) filter.$or = [{ title: { $regex: escapeRegex(q), $options: 'i' } }, { body: { $regex: escapeRegex(q), $options: 'i' } }];
  }
  if (query.from !== undefined || query.to !== undefined) {
    const from = query.from !== undefined ? ymd(query.from) : null;
    const to = query.to !== undefined ? ymd(query.to) : null;
    if ((query.from !== undefined && from === null) || (query.to !== undefined && to === null)) return { ok: false, code: 'INVALID_FILTER', field: 'date' };
    filter.createdAt = { ...(from !== null ? { $gte: new Date(from) } : {}), ...(to !== null ? { $lt: new Date(to + 24 * 3600 * 1000) } : {}) };
  }
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 50);
  const page = Math.min(Math.max(parseInt(query.page, 10) || 1, 1), 1000);
  const [items, total] = await Promise.all([
    EngagementTemplate.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    EngagementTemplate.countDocuments(filter),
  ]);
  return { ok: true, items, total, page, limit };
}

async function get(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return EngagementTemplate.findById(id).lean();
}

module.exports = {
  TRANSITIONS, createFromBatch, existingFor, transition, revise, loadActiveTemplates, recordUsage, refreshPerformance, list, get,
};
