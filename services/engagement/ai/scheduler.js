// services/engagement/ai/scheduler.js
// -----------------------------------------------------------------------------
// Scheduled template generation (Phase 2). Its own timer — independent of the Phase 1
// notification worker, which never waits for it.
//
// Runs only when BOTH ENGAGEMENT_AI_ENABLED=true and ENGAGEMENT_AI_SCHEDULE_ENABLED=true.
// Every ENGAGEMENT_AI_SCHEDULE_INTERVAL_HOURS (default 24) it looks for gaps:
// (category, purpose, language) groups — enabled categories only, SEASONAL never — with
// fewer than ENGAGEMENT_AI_TARGET_POOL_SIZE live-or-pending templates (DRAFT, APPROVED,
// ACTIVE). It generates at most ENGAGEMENT_AI_MAX_BATCHES_PER_RUN batches, and stops the
// run at the first batch that could not reach any provider. Identical prompts inside the
// regeneration window are refused by the generator, so a gap that cannot be filled does
// not burn tokens every run. No loop: one bounded pass per interval.
// -----------------------------------------------------------------------------
'use strict';

const EngagementTemplate = require('../../../models/EngagementTemplate');
const aiConfig = require('../../../config/engagementAiConfig');
const engagementConfig = require('../../../config/engagementNotificationConfig');
const { PURPOSES } = require('../variables');
const generator = require('./generator');
const log = require('../log');

const DEFAULT_TONE = Object.freeze({
  NEARBY: ['friendly', 'curious', 'community'], COMMUNITY: ['community', 'curious', 'warm'],
  SPORTS: ['friendly', 'lighthearted', 'warm'], ROOMS: ['conversational', 'curious', 'friendly'],
  SOCIAL: ['warm', 'friendly'], FUNNY: ['funny', 'lighthearted'], INFORMATIVE: ['informative', 'friendly'],
});

const state = { timer: null, running: null, started: false };

/** Groups that need templates, smallest pool first. */
async function findGaps(cfg, engCfg) {
  const groups = [];
  for (const category of engCfg.enabledCategories) {
    if (category === 'SEASONAL') continue;
    for (const purpose of Object.keys(PURPOSES[category] || {})) {
      for (const language of cfg.scheduleLanguages) groups.push({ category, purpose, language });
    }
  }
  const counts = await EngagementTemplate.aggregate([
    { $match: { status: { $in: ['DRAFT', 'APPROVED', 'ACTIVE'] } } },
    { $group: { _id: { c: '$category', p: '$purpose', l: '$language' }, n: { $sum: 1 } } },
  ]);
  const have = new Map(counts.map(r => [`${r._id.c}|${r._id.p}|${r._id.l}`, r.n]));
  return groups
    .map(g => ({ ...g, have: have.get(`${g.category}|${g.purpose}|${g.language}`) || 0 }))
    .filter(g => g.have < cfg.targetPoolSize)
    .sort((a, b) => a.have - b.have || `${a.category}${a.purpose}${a.language}`.localeCompare(`${b.category}${b.purpose}${b.language}`));
}

async function runOnce({ now = Date.now() } = {}) {
  const cfg = aiConfig.get();
  if (!cfg.enabled || !cfg.scheduleEnabled) return { ran: false, reason: 'DISABLED' };
  if (await require('../control').isAiPaused()) return { ran: false, reason: 'AI_PAUSED' };
  const gaps = await findGaps(cfg, engagementConfig.get());
  const out = { ran: true, gaps: gaps.length, batches: [] };
  const day = Math.floor(now / 86400000);
  for (const g of gaps.slice(0, cfg.maxBatchesPerRun)) {
    const tones = DEFAULT_TONE[g.category] || ['friendly'];
    const r = await generator.generateNow({
      category: g.category, purpose: g.purpose, language: g.language,
      tone: tones[day % tones.length], count: Math.min(cfg.maxBatchSize, cfg.targetPoolSize - g.have),
    }, { trigger: 'SCHEDULED', now });
    out.batches.push({ category: g.category, purpose: g.purpose, language: g.language, ok: r.ok, code: r.ok ? r.result.status : r.code });
    if (!r.ok && r.code === 'GENERATION_IN_PROGRESS') break;
    if (r.ok && r.result.status === 'FAILED' && /^(NO_PROVIDER_AVAILABLE|ALL_PROVIDERS_FAILED)/.test(r.result.failureReason || '')) break;
  }
  log.info('generation_schedule_run', { gaps: out.gaps, batches: out.batches.length, results: out.batches.map(b => b.code) });
  return out;
}

function start() {
  const cfg = aiConfig.get();
  if (!cfg.enabled || !cfg.scheduleEnabled) {
    log.info('ai_startup', { state: 'OFF', generation: cfg.enabled ? 'manual only' : 'disabled', note: 'Scheduled template generation needs ENGAGEMENT_AI_ENABLED and ENGAGEMENT_AI_SCHEDULE_ENABLED.' });
    return false;
  }
  if (state.started) return true;
  state.started = true;
  log.info('ai_startup', { state: 'ON', intervalHours: cfg.scheduleIntervalMs / 3600000, primary: cfg.primary, fallback: cfg.fallback, approvalPolicy: cfg.approvalPolicy });
  const loop = delay => {
    state.timer = setTimeout(() => {
      state.running = runOnce().catch(err => log.error('generation_schedule_error', { err: log.errTag(err) }))
        .finally(() => { state.running = null; if (state.started) loop(aiConfig.get().scheduleIntervalMs); });
    }, delay);
    if (state.timer.unref) state.timer.unref();
  };
  loop(10 * 60 * 1000);   // first run 10 minutes after boot
  return true;
}

async function stop({ timeoutMs = 3000 } = {}) {
  state.started = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.running) await Promise.race([state.running, new Promise(r => setTimeout(r, timeoutMs).unref())]);
}

module.exports = { start, stop, runOnce, findGaps };
