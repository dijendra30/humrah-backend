// services/engagement/ai/generator.js
// -----------------------------------------------------------------------------
// Template GENERATION ENGINE (Phase 2). One call = one batch of reusable templates for
// one (category, purpose, language, tone). Never per recipient; the notification worker
// never calls this.
//
//   begin(input)  validate request → AI enabled? → no identical prompt in the regen
//                 window (no tokens spent twice) → distributed lock 'generator'
//                 (EngagementWorkerLock; one generation at a time across instances) →
//                 batch history row (RUNNING)
//   run(batch)    generic prompt → NotificationAIService (Gemini → Groq, cooldowns) →
//                 parse → validate every candidate (validator.validateBatch: safety,
//                 placeholders, language, length, duplicates/near-duplicates against the
//                 batch and stored templates) → store accepted as DRAFT (or APPROVED under
//                 the auto_approve policy — never ACTIVE) → finish history → release lock
//
// A failure anywhere leaves the worker untouched: it keeps using ACTIVE templates.
// -----------------------------------------------------------------------------
'use strict';

const os = require('os');
const crypto = require('crypto');
const EngagementGenerationBatch = require('../../../models/EngagementGenerationBatch');
const EngagementWorkerLock = require('../../../models/EngagementWorkerLock');
const aiConfig = require('../../../config/engagementAiConfig');
const validator = require('./validator');
const prompt = require('./prompt');
const aiService = require('./notificationAiService');
const templateStore = require('../templateStore');
const log = require('../log');

const LOCK_ID = 'generator';
const ownerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

async function acquireLock(now, ms) {
  try {
    return await EngagementWorkerLock.findOneAndUpdate(
      { _id: LOCK_ID, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date(now) } }] },
      { $set: { owner: ownerId, leaseUntil: new Date(now + ms) } },
      { upsert: true, new: true }
    ).lean();
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
}
async function releaseLock(summary) {
  await EngagementWorkerLock.updateOne({ _id: LOCK_ID, owner: ownerId }, { $set: { leaseUntil: null, lastRunAt: new Date(), lastSummary: summary || null } });
}

/** A crash can leave a RUNNING batch behind; once its lock lease is long gone, close it. */
async function closeInterruptedBatches(now, cfg) {
  const r = await EngagementGenerationBatch.updateMany(
    { status: 'RUNNING', startedAt: { $lt: new Date(now - cfg.lockMs * 2) } },
    { $set: { status: 'FAILED', failureReason: 'INTERRUPTED', finishedAt: new Date(now) } }
  );
  if (r.modifiedCount) log.warn('generation_interrupted_closed', { count: r.modifiedCount });
}

/**
 * @param {object} input  raw request (admin body or scheduler)
 * @param {object} opts   { trigger: 'MANUAL'|'SCHEDULED', requestedBy, now }
 * @returns {Promise<{ok:true, batch}|{ok:false, code, field?, status}>}  status = suggested HTTP status
 */
async function begin(input, { trigger = 'MANUAL', requestedBy = null, now = Date.now() } = {}) {
  const cfg = aiConfig.get();
  if (!cfg.enabled) return { ok: false, code: 'AI_GENERATION_DISABLED', status: 503 };
  // Phase 3: the dashboard's AI pause (database switch). Delivery is unaffected.
  if (await require('../control').isAiPaused()) return { ok: false, code: 'AI_GENERATION_PAUSED', status: 503 };
  const v = validator.validateRequest(input, cfg);
  if (!v.ok) return { ok: false, code: v.code, field: v.field, status: 400 };
  const req = v.value;
  const hash = prompt.promptHash(req);

  await closeInterruptedBatches(now, cfg);
  if (!req.force && cfg.regenMinMs > 0) {
    const recent = await EngagementGenerationBatch.exists({ promptHash: hash, status: { $in: ['RUNNING', 'SUCCEEDED'] }, createdAt: { $gte: new Date(now - cfg.regenMinMs) } });
    if (recent) return { ok: false, code: 'DUPLICATE_REQUEST', status: 409 };
  }
  const lock = await acquireLock(now, cfg.lockMs);
  if (!lock) { log.info('generation_lock_conflict', {}); return { ok: false, code: 'GENERATION_IN_PROGRESS', status: 409 }; }

  try {
    const batch = await EngagementGenerationBatch.create({
      trigger, requestedBy: trigger === 'MANUAL' ? requestedBy : null,
      request: { category: req.category, purpose: req.purpose, language: req.language, tone: req.tone, count: req.count, titleMax: req.titleMax, bodyMax: req.bodyMax, variables: req.variables },
      promptHash: hash, promptVersion: prompt.PROMPT_VERSION, status: 'RUNNING', startedAt: new Date(now),
    });
    log.info('generation_started', { batchId: String(batch._id), trigger, category: req.category, purpose: req.purpose, language: req.language, tone: req.tone, count: req.count });
    return { ok: true, batch: batch.toObject() };
  } catch (err) {
    await releaseLock({ error: log.errTag(err) });
    throw err;
  }
}

const countBy = list => list.reduce((acc, r) => { acc[r.code] = (acc[r.code] || 0) + 1; return acc; }, {});

/** Finish a begun batch. Never throws; always releases the lock. */
async function run(batch, { now = () => Date.now() } = {}) {
  const cfg = aiConfig.get();
  const started = now();
  const req = batch.request;
  const finish = async (fields) => {
    const done = { ...fields, finishedAt: new Date(now()), durationMs: now() - started };
    await EngagementGenerationBatch.updateOne({ _id: batch._id }, { $set: done });
    log.info('generation_finished', {
      batchId: String(batch._id), status: done.status, provider: done.provider || null, generated: done.generatedCount || 0,
      accepted: done.acceptedCount || 0, rejected: done.rejectedCount || 0, reasons: done.rejectionReasons || {}, failureReason: done.failureReason || null, durationMs: done.durationMs,
    });
    return { batchId: batch._id, ...done };
  };
  try {
    const existing = await templateStore.existingFor(req.category, req.language);
    const p = prompt.buildPrompt(req, existing.map(e => `${e.title} — ${e.body}`));
    const res = await aiService.generate(p, { cfg, validateText: t => validator.parseCandidates(t).ok });
    if (!res.ok) return await finish({ status: 'FAILED', attempts: res.attempts, failureReason: res.failureReason });

    const parsed = validator.parseCandidates(res.text);
    if (!parsed.ok) return await finish({ status: 'FAILED', provider: res.provider, model: res.model, attempts: res.attempts, failureReason: parsed.code });

    const ctx = { ...req, existing, similarityThreshold: cfg.similarityThreshold };
    const { accepted, rejected } = validator.validateBatch(parsed.items.slice(0, req.count * 2), ctx);
    const storedRes = await templateStore.createFromBatch(accepted.slice(0, req.count), { request: req, batchId: batch._id, provider: res.provider, model: res.model });
    const allRejected = [...rejected, ...storedRes.rejected];
    return await finish({
      status: storedRes.stored.length ? 'SUCCEEDED' : 'FAILED',
      provider: res.provider, model: res.model, attempts: res.attempts,
      generatedCount: parsed.items.length, acceptedCount: storedRes.stored.length, rejectedCount: allRejected.length,
      rejectionReasons: countBy(allRejected), templateIds: storedRes.stored,
      failureReason: storedRes.stored.length ? null : 'ALL_CANDIDATES_REJECTED',
    });
  } catch (err) {
    log.error('generation_error', { batchId: String(batch._id), err: log.errTag(err) });
    try { return await finish({ status: 'FAILED', failureReason: 'INTERNAL_ERROR' }); } catch (_) { return { batchId: batch._id, status: 'FAILED' }; }
  } finally {
    try { await releaseLock({ batchId: String(batch._id) }); } catch (_) { /* lease expires */ }
  }
}

/** begin + run, awaited (scheduler and tests). */
async function generateNow(input, opts = {}) {
  const b = await begin(input, opts);
  if (!b.ok) return b;
  const r = await run(b.batch);
  return { ok: true, batchId: b.batch._id, result: r };
}

module.exports = { begin, run, generateNow, LOCK_ID, _internal: { acquireLock, releaseLock, closeInterruptedBatches } };
