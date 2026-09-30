// services/sportsDiscoveryControl.js
// -----------------------------------------------------------------------------
// Sports discovery (Phase 5D): the parts that keep the feature safe to leave running and
// safe to hand to an operator. None of it changes WHO is notified (that is
// sportsDiscoveryService.js and SPORTS_PHASE_5A_PRODUCT_RULES.md).
//
//   checkGate       before any work: is the breaker tripped, and do the unique indexes
//                   that make duplicates impossible really exist? (fail closed)
//   trip            the circuit breaker: persist the reason and stop, until
//                   SPORTS_DISCOVERY_STARTED_AT is set to a later time
//   auditInvariants after a tick that sent: re-count the people just notified and prove
//                   no cap was exceeded; a breach trips the breaker
//   finishTick      error-streak bookkeeping, the last-tick summary, a heartbeat
//   buildStatus     the read-only report behind GET /api/admin/sports-discovery/status
//
// Logs: aggregate reasons only. No user ids, tokens or coordinates.
// -----------------------------------------------------------------------------
'use strict';

const SportsDiscoveryControl = require('../models/SportsDiscoveryControl');
const SportsDiscoveryRun = require('../models/SportsDiscoveryRun');
const SportsDiscoveryDelivery = require('../models/SportsDiscoveryDelivery');
const User = require('../models/User');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY = SportsDiscoveryControl.KEY;

const ERROR_TICK_LIMIT = 10;          // ticks in a row with an error before the breaker trips
const HEARTBEAT_MS = 10 * MIN;        // an idle tick still records "alive" this often
const INDEX_OK_TTL_MS = 10 * MIN;     // a successful index check is trusted this long
const INDEX_BAD_TTL_MS = 30 * 1000;   // a failed one is re-checked quickly

// A short, id-free description of an error for the log: its name and code, never its message
// (messages can contain values).
const errTag = err => `${(err && err.name) || 'Error'}${err && err.code !== undefined && err.code !== null ? ':' + String(err.code).slice(0, 24) : ''}`;

// One log line per key per interval, so a persistent condition cannot flood the log.
const lastLogged = new Map();
function logEvery(key, everyMs, fn) {
  const now = Date.now();
  if (lastLogged.has(key) && now - lastLogged.get(key) < everyMs) return;
  lastLogged.set(key, now);
  fn();
}

// The breaker also lives in memory, so a database that cannot be written still stops THIS process.
let memoryTrip = null;
let indexCache = { at: 0, ok: false, detail: null };

function reset() {   // tests only
  memoryTrip = null;
  indexCache = { at: 0, ok: false, detail: null };
  lastLogged.clear();
}

/** Tripped, unless the configured activation time is later than the trip. */
const isTripped = (trippedAt, startedAt) => !!trippedAt && startedAt <= new Date(trippedAt).getTime();

// ── Indexes ───────────────────────────────────────────────────────────────────
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Do the indexes exist? Mongoose builds them automatically and ignores a failure, so the two
 * that make duplicates impossible are CHECKED here (the unique (plan, user) index and the
 * unique per-plan run index). The rest are reported but are only performance.
 *
 * Also CHECKED: users { liveLocation: '2dsphere' }, declared in models/User.js. The candidate
 * query is a $near on it, and without it MongoDB refuses the query (MongoServerError 291,
 * "unable to find index for $geoNear query"). Its build fails, silently, when any user holds a
 * liveLocation that is not valid GeoJSON. Without it discovery does not run at all: nothing is
 * claimed, nothing is sent, and the status route names the missing index.
 */
async function indexState(force = false) {
  const now = Date.now();
  if (!force && indexCache.at && now - indexCache.at < (indexCache.ok ? INDEX_OK_TTL_MS : INDEX_BAD_TTL_MS)) return indexCache;
  const detail = {
    runUniquePlan: false, deliveryUniquePlanUser: false,   // safety-critical
    userLiveLocationGeo: false,                             // required: the candidate query cannot run without it
    deliveryUserClaimed: false, deliveryRetryPartial: false, deliveryTtl: false, runTtl: false,   // performance / housekeeping
  };
  try { await Promise.all([SportsDiscoveryRun.init(), SportsDiscoveryDelivery.init()]); }
  catch (err) { detail.initError = errTag(err); }
  try {
    const [ri, di] = await Promise.all([SportsDiscoveryRun.collection.indexes(), SportsDiscoveryDelivery.collection.indexes()]);
    const find = (list, key) => list.find(i => sameKey(i.key, key));
    detail.runUniquePlan = !!(find(ri, { sportsPlanId: 1 }) && find(ri, { sportsPlanId: 1 }).unique === true);
    detail.deliveryUniquePlanUser = !!(find(di, { sportsPlanId: 1, userId: 1 }) && find(di, { sportsPlanId: 1, userId: 1 }).unique === true);
    detail.deliveryUserClaimed = !!find(di, { userId: 1, claimedAt: -1 });
    detail.deliveryRetryPartial = !!(find(di, { retryUntil: 1 }) && find(di, { retryUntil: 1 }).partialFilterExpression);
    detail.deliveryTtl = !!(find(di, { createdAt: 1 }) && find(di, { createdAt: 1 }).expireAfterSeconds > 0);
    detail.runTtl = !!(find(ri, { createdAt: 1 }) && find(ri, { createdAt: 1 }).expireAfterSeconds > 0);
  } catch (err) { detail.listError = errTag(err); }
  try {
    detail.userLiveLocationGeo = !!(await User.collection.indexes()).find(i => sameKey(i.key, { liveLocation: '2dsphere' }));
  } catch (err) { detail.userListError = errTag(err); }
  indexCache = { at: now, ok: detail.runUniquePlan && detail.deliveryUniquePlanUser && detail.userLiveLocationGeo, detail };
  return indexCache;
}

// ── The gate ──────────────────────────────────────────────────────────────────
/**
 * Called once per tick, only when the environment gate is open. Returns { ok, reason, control }.
 * Reads one document; and re-arms (once) when SPORTS_DISCOVERY_STARTED_AT is later than the trip.
 */
async function checkGate(cfg, now) {
  if (memoryTrip) {
    if (cfg.startedAt > memoryTrip.at) memoryTrip = null;   // a later activation time re-arms this process too
    else return { ok: false, reason: 'tripped' };
  }
  const idx = await indexState();
  if (!idx.ok) {
    const d = idx.detail || {};
    if (d.runUniquePlan && d.deliveryUniquePlanUser && !d.userLiveLocationGeo) {
      logEvery('index', 5 * MIN, () => console.error('[SPORTS_DISCOVERY] NOT RUNNING: users has no { liveLocation: "2dsphere" } index, so the candidate query cannot run (MongoServerError 291). Nothing is claimed or sent.'));
    } else {
      logEvery('index', 5 * MIN, () => console.error('[SPORTS_DISCOVERY] NOT RUNNING: the unique indexes that prevent duplicate notifications are missing or could not be verified.'));
    }
    return { ok: false, reason: 'index_missing' };
  }
  let control = await SportsDiscoveryControl.findById(KEY).lean();
  if (control && control.trippedAt) {
    if (isTripped(control.trippedAt, cfg.startedAt)) {
      logEvery('tripped', 30 * MIN, () => console.error(`[SPORTS_DISCOVERY] NOT RUNNING: circuit breaker tripped (${control.tripReason}). Set SPORTS_DISCOVERY_STARTED_AT to a time after the trip and restart to re-arm.`));
      return { ok: false, reason: 'tripped', control };
    }
    // Re-armed by a later activation time: remember the trip, clear it, reset the counters.
    await SportsDiscoveryControl.updateOne(
      { _id: KEY, trippedAt: control.trippedAt },
      { $set: { lastTrip: { at: control.trippedAt, reason: control.tripReason, detail: control.tripDetail }, rearmedAt: new Date(now), consecutiveErrorTicks: 0 },
        $unset: { trippedAt: '', tripReason: '', tripDetail: '' } });
    console.log('[SPORTS_DISCOVERY] circuit breaker re-armed by a later SPORTS_DISCOVERY_STARTED_AT.');
    control = await SportsDiscoveryControl.findById(KEY).lean();
  }
  return { ok: true, control };
}

/** Trip the breaker: stop this process now and persist the stop. */
async function trip(reason, detail, now) {
  memoryTrip = { at: now, reason };
  console.error(`[SPORTS_DISCOVERY] TRIPPED (${reason}): discovery stops now and stays off until SPORTS_DISCOVERY_STARTED_AT is set to a later time and the app restarts.`);
  await SportsDiscoveryControl.findOneAndUpdate(
    { _id: KEY },
    { $set: { trippedAt: new Date(now), tripReason: reason, tripDetail: detail || null } },
    { upsert: true });
}

// ── The invariant audit ───────────────────────────────────────────────────────
/**
 * After a tick that sent, re-read every counted delivery of the people just notified (since
 * the activation time) and prove the caps held: at most cfg.capHour in any 60 minutes, at
 * most cfg.capDay in any 24 hours, at most one per creator in cfg.creatorMs. The send path
 * is built so this can never fail; this is the alarm if it ever does.
 * Returns { checked, violations, kinds }.
 */
async function auditInvariants(userIds, now, cfg) {
  const ids = [...new Set((userIds || []).map(String))];
  const out = { checked: ids.length, violations: 0, kinds: {} };
  if (ids.length === 0) return out;
  const rows = await SportsDiscoveryDelivery.find({
    userId: { $in: ids },
    status: { $in: SportsDiscoveryDelivery.COUNTED },
    claimedAt: { $gte: new Date(Math.max(cfg.startedAt, now - Math.max(7 * DAY, cfg.creatorMs))) },
  }).select('userId creatorId claimedAt').lean();
  const byUser = new Map();
  for (const r of rows) {
    const k = String(r.userId);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push({ t: new Date(r.claimedAt).getTime(), creator: String(r.creatorId) });
  }
  const bump = kind => { out.violations++; out.kinds[kind] = (out.kinds[kind] || 0) + 1; };
  for (const list of byUser.values()) {
    list.sort((a, b) => a.t - b.t);
    for (const r of list) {
      const within = ms => list.filter(x => x.t <= r.t && x.t >= r.t - ms);
      if (within(HOUR).length > cfg.capHour) bump('cap_hour');
      if (within(DAY).length > cfg.capDay) bump('cap_day');
      if (within(cfg.creatorMs).filter(x => x.creator === r.creator).length > 1) bump('cap_creator');
    }
  }
  return out;
}

// ── Tick bookkeeping ──────────────────────────────────────────────────────────
const NUM = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numberMap = m => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, NUM(v)]));

/** The stored last-tick summary: counts only. */
function publicSummary(s) {
  return {
    scanned: NUM(s.scanned), plans: NUM(s.plans), candidates: NUM(s.candidates), eligible: NUM(s.eligible), selected: NUM(s.selected),
    sent: NUM(s.sent), failed: NUM(s.failed), retried: NUM(s.retried), errors: NUM(s.errors),
    skipped: numberMap(s.skipped), dropped: numberMap(s.dropped), tripped: s.tripped || null,
  };
}

/**
 * Persist what a tick did (only when it did something, plus a heartbeat every ten minutes) and
 * count consecutive ticks with errors. Trips the breaker at ERROR_TICK_LIMIT.
 */
async function finishTick(control, summary, now) {
  const prev = (control && control.consecutiveErrorTicks) || 0;
  const streak = summary.errors > 0 ? prev + 1 : 0;
  const active = summary.plans > 0 || summary.retried > 0 || summary.errors > 0 || !!summary.tripped;
  const lastHb = control && control.lastHeartbeatAt ? new Date(control.lastHeartbeatAt).getTime() : 0;
  const heartbeat = now - lastHb >= HEARTBEAT_MS;
  const set = {};
  if (streak !== prev) set.consecutiveErrorTicks = streak;
  if (active || heartbeat) {
    set.lastTickAt = new Date(now);
    set.lastTick = publicSummary(summary);
    if (heartbeat) set.lastHeartbeatAt = new Date(now);
  }
  if (Object.keys(set).length > 0) await SportsDiscoveryControl.updateOne({ _id: KEY }, { $set: set }, { upsert: true });
  if (streak >= ERROR_TICK_LIMIT) {
    await trip('error_streak', { ticks: streak }, now);
    return 'error_streak';
  }
  return null;
}

// ── The read-only status report ───────────────────────────────────────────────
function firebaseState() {
  try { return { initialized: require('firebase-admin').apps.length > 0 }; }
  catch (err) { return { initialized: false, error: errTag(err) }; }
}

const guarded = async (label, out, fn) => {
  try { out[label] = await fn(); } catch (err) { out[label] = null; (out.errors = out.errors || {})[label] = errTag(err); }
};

/**
 * Everything Phase 5E needs to know, and nothing that can identify a person. Read-only: no
 * write, no push, no toggle. [deep] adds bounded counts that scan the users collection
 * (each capped at 5 seconds) and is therefore opt-in.
 */
async function buildStatus({ cfg, deep = false }) {
  const now = Date.now();
  const startedAtValid = cfg.startedAt !== null;
  const control = await SportsDiscoveryControl.findById(KEY).lean();
  const idx = await indexState(true);
  const tripped = !!(control && control.trippedAt) && isTripped(control.trippedAt, cfg.startedAt || 0);
  const breakerTripped = tripped || (!!memoryTrip && (cfg.startedAt || 0) <= memoryTrip.at);

  const out = {};
  await guarded('runs', out, () => SportsDiscoveryRun.estimatedDocumentCount());
  await guarded('deliveries', out, () => SportsDiscoveryDelivery.estimatedDocumentCount());
  const byStatus = {};
  const last24h = {};
  try {
    for (const row of await SportsDiscoveryDelivery.aggregate([
      { $match: { createdAt: { $gte: new Date(now - DAY) } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).option({ maxTimeMS: 5000 })) last24h[row._id] = row.n;
    for (const row of await SportsDiscoveryDelivery.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).option({ maxTimeMS: 5000 })) byStatus[row._id] = row.n;
  } catch (err) { (out.errors = out.errors || {}).byStatus = errTag(err); }

  const gate = {
    enabled: !!cfg.enabled,
    startedAt: startedAtValid ? new Date(cfg.startedAt).toISOString() : null,
    startedAtValid,
    // "running" = the environment gate is open AND nothing stops it. When it is false, discovery sends nothing.
    running: !!cfg.enabled && startedAtValid && !breakerTripped && idx.ok,
  };
  const firebase = firebaseState();
  const blockers = [];
  const warnings = [];
  if (!idx.ok) blockers.push('indexes_missing');
  if (idx.detail && idx.detail.userLiveLocationGeo === false) blockers.push('user_live_location_index_missing');
  if (breakerTripped) blockers.push('breaker_tripped');
  if (!firebase.initialized) blockers.push('firebase_not_initialized');
  if (cfg.enabled && !startedAtValid) blockers.push('started_at_missing_or_invalid');

  const result = {
    generatedAt: new Date(now).toISOString(),
    gate,
    config: {
      radiusKm: cfg.radiusKm, freshHours: cfg.freshMs / HOUR, participationDays: cfg.participationMs / DAY, minLeadMin: cfg.minLeadMs / MIN,
      windowMin: cfg.windowMs / MIN, maxRecipients: cfg.maxRecipients, maxCandidates: cfg.maxCandidates, maxPlansPerTick: cfg.maxPlansPerTick,
      capHour: cfg.capHour, capDay: cfg.capDay, creatorDays: cfg.creatorMs / DAY, retryMin: cfg.retryWindowMs / MIN,
      uncertainMin: cfg.uncertainMs / MIN, leaseMin: cfg.leaseMs / MIN,
    },
    breaker: {
      tripped: breakerTripped,
      trippedAt: control && control.trippedAt ? new Date(control.trippedAt).toISOString() : (memoryTrip ? new Date(memoryTrip.at).toISOString() : null),
      reason: (control && control.tripReason) || (memoryTrip && memoryTrip.reason) || null,
      lastTrip: control && control.lastTrip ? control.lastTrip : null,
      rearmedAt: control && control.rearmedAt ? new Date(control.rearmedAt).toISOString() : null,
      consecutiveErrorTicks: (control && control.consecutiveErrorTicks) || 0,
    },
    lastTick: control && control.lastTick ? control.lastTick : null,
    lastTickAt: control && control.lastTickAt ? new Date(control.lastTickAt).toISOString() : null,
    lastHeartbeatAt: control && control.lastHeartbeatAt ? new Date(control.lastHeartbeatAt).toISOString() : null,
    indexes: idx.detail,
    totals: { runs: out.runs, deliveries: out.deliveries, deliveriesByStatus: byStatus, deliveriesLast24h: last24h },
    firebase,
    ...(out.errors ? { errors: out.errors } : {}),
  };

  if (deep) {
    const d = {};
    await guarded('capableUsers', d, () => User.countDocuments({ fcmDevices: { $elemMatch: { supportsSportsDiscovery: true } } }).maxTimeMS(5000));
    await guarded('activeUsers', d, () => User.countDocuments({ status: 'ACTIVE' }).maxTimeMS(5000));
    await guarded('usersWithoutStatus', d, () => User.countDocuments({ status: { $exists: false } }).maxTimeMS(5000));
    await guarded('freshLocationUsers', d, () => User.countDocuments({ 'liveLocation.updatedAt': { $gte: new Date(now - cfg.freshMs) } }).maxTimeMS(5000));
    result.deep = d;
    if (d.capableUsers === 0) warnings.push('no_capable_devices_yet');
    if (d.usersWithoutStatus > 0) warnings.push('users_without_status_are_not_eligible');
  }
  result.ready = { toEnable: blockers.length === 0, blockers, warnings };
  return result;
}

module.exports = {
  checkGate, trip, auditInvariants, finishTick, buildStatus, indexState, errTag, publicSummary,
  ERROR_TICK_LIMIT,
  _internal: { reset, isTripped, HEARTBEAT_MS },
};
