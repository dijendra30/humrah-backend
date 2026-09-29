// services/sportsDiscoveryService.js
// -----------------------------------------------------------------------------
// Sports discovery (Phase 5C): when a verified user creates a Sports plan, tell a
// small number of nearby people who are likely to want to play and are able to
// join — once, in plain words. The rules are SPORTS_PHASE_5A_PRODUCT_RULES.md; the
// design is SPORTS_PHASE_5B_TECHNICAL_PLAN.md. This file decides nothing new.
//
//   existing every-minute Sports cron (cronJobs.js)
//     └─ tickSportsDiscovery()
//          0. kill switch + rollout marker           (off unless both are set)
//          1. retry pass                             one retry per failed push
//          2. resume pass                            runs whose worker died
//          3. plans created in the last 30 minutes   claim → select ONCE → send
//
// Everything is a conditional Mongo update, so it survives a restart and is safe on
// several servers at once. createPlan / joinPlan / getNearbyPlans are not touched:
// the plan page and the atomic join stay the authority (a tap fetches the plan
// fresh). It never sends anything unless SPORTS_DISCOVERY_ENABLED=true AND
// SPORTS_DISCOVERY_STARTED_AT is a valid time.
//
// Logs: aggregate counts and reasons only. No ids, coordinates or tokens.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const SportsPlan = require('../models/SportsPlan');
const User = require('../models/User');
const SportsDiscoveryRun = require('../models/SportsDiscoveryRun');
const SportsDiscoveryDelivery = require('../models/SportsDiscoveryDelivery');

// Lazy, like the other Sports services, so requiring this file loads nothing heavy.
const fcm = () => require('../utils/fcmHelper');
const chat = () => require('./sportsChatService');
const plans = () => require('./sportsPlanService');

const { ObjectId } = mongoose.Types;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const TYPE = 'SPORTS_PLAN_DISCOVERY';
const MAX_ATTEMPTS = 3;             // claims per plan (a crash-loop guard)
const RETRY_DELAY_MS = 2 * MIN;     // "approximately 2 minutes later" (5A §16)
const TICK_BUDGET_MS = 45 * SEC;    // no new plan is claimed after this
const CAP_LOOKBACK_MS = 7 * DAY;

// ── Configuration ─────────────────────────────────────────────────────────────
// The ROOM_ENGAGEMENT_ENABLED / SPORTS_MESSAGE_PUSH_ENABLED convention: unset or
// blank = the default; otherwise on only when it says "true". Read on every use.
const envBool = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  return String(v).trim().toLowerCase() === 'true';
};

const warned = new Set();
function warnOnce(key, text) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[SPORTS_DISCOVERY] ${text}`);
}

// A whole number in [min, max]. Unset = the default. Anything unusable (not a
// number, or outside the range) = the 5A default, never something looser.
function envInt(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    warnOnce(`cfg:${name}`, `${name} is not a whole number from ${min} to ${max}; using the default ${def}.`);
    return def;
  }
  return n;
}

function config() {
  const enabled = envBool(process.env.SPORTS_DISCOVERY_ENABLED, false);
  const rawStart = process.env.SPORTS_DISCOVERY_STARTED_AT;
  const startedAt = rawStart && String(rawStart).trim() ? Date.parse(String(rawStart).trim()) : NaN;
  return {
    enabled,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    radiusKm:        envInt('SPORTS_DISCOVERY_RADIUS_KM', 10, 1, 20),
    freshMs:         envInt('SPORTS_DISCOVERY_FRESH_HOURS', 72, 1, 24 * 30) * HOUR,
    participationMs: envInt('SPORTS_DISCOVERY_PARTICIPATION_DAYS', 90, 1, 365) * DAY,
    minLeadMs:       envInt('SPORTS_DISCOVERY_MIN_LEAD_MIN', 30, 1, 24 * 60) * MIN,
    windowMs:        envInt('SPORTS_DISCOVERY_WINDOW_MIN', 30, 1, 24 * 60) * MIN,
    maxRecipients:   envInt('SPORTS_DISCOVERY_MAX_RECIPIENTS', 50, 1, 500),
    maxCandidates:   envInt('SPORTS_DISCOVERY_MAX_CANDIDATES', 200, 1, 1000),
    maxPlansPerTick: envInt('SPORTS_DISCOVERY_MAX_PLANS_PER_TICK', 20, 1, 200),
    capHour:         envInt('SPORTS_DISCOVERY_CAP_HOUR', 1, 1, 100),
    capDay:          envInt('SPORTS_DISCOVERY_CAP_DAY', 3, 1, 1000),
    creatorMs:       envInt('SPORTS_DISCOVERY_CREATOR_DAYS', 7, 1, 30) * DAY,
    retryWindowMs:   envInt('SPORTS_DISCOVERY_RETRY_MIN', 10, 1, 24 * 60) * MIN,
    // Read for completeness; nothing ever resends a 'sending' row, however old — the
    // "possibly delivered, never resent" guarantee is structural (see the model).
    uncertainMs:     envInt('SPORTS_DISCOVERY_UNCERTAIN_MIN', 5, 1, 24 * 60) * MIN,
    leaseMs:         envInt('SPORTS_DISCOVERY_LEASE_MIN', 5, 1, 60) * MIN,
  };
}

// ── Small pure helpers (unit-tested through _internal) ────────────────────────
const same = (a, b) => String(a) === String(b);
const includesId = (list, id) => (list || []).some(x => same(x, id));

// The exact 5A §5(B) labels. Compared after trim + lowercase, by EQUALITY: never a
// substring, a pattern, another field, or another spelling.
const INTEREST_LABELS = Object.freeze({
  hobbies:               ['sports', 'fitness'],
  humrahRoomInterests:   ['sports', 'fitness & wellness'],
  conversationInterests: ['sports & fitness'],
});
function hasSportsInterest(questionnaire) {
  if (!questionnaire || typeof questionnaire !== 'object') return false;
  return Object.entries(INTEREST_LABELS).some(([field, labels]) => {
    const values = questionnaire[field];
    return Array.isArray(values)
      && values.some(v => typeof v === 'string' && labels.includes(v.trim().toLowerCase()));
  });
}

// The join rule (sportsPlanService.isVerified): the same two conditions.
const isVerified = u => !!u && (u.verified === true || u.photoVerificationStatus === 'approved');

// 5A §7: suspended unless suspendedUntil is set and already past.
function isSuspended(u, now) {
  const s = u && u.suspensionInfo;
  if (!s || s.isSuspended !== true) return false;
  if (s.suspendedUntil && new Date(s.suspendedUntil).getTime() <= now) return false;
  return true;
}

// 5A §23: only devices that declared the capability, and only real tokens.
function capableTokens(u) {
  const out = [];
  for (const d of (u && u.fcmDevices) || []) {
    if (d && d.supportsSportsDiscovery === true && typeof d.token === 'string' && d.token.trim()) out.push(d.token.trim());
  }
  return [...new Set(out)];
}

const pushOff = u => !!(u && u.notifications && u.notifications.pushNotifications === false);
const nearbyOff = u => !!(u && u.notifications && u.notifications.nearbyActivities === false);

// Existing mutual semantics (sportsChatService.blockedEitherWay): either lists the other.
const blockedEitherWay = (a, b) => !!a && !!b && (
  includesId(a.blockedUsers, b._id) || includesId(b.blockedUsers, a._id)
);

/**
 * 5A §15 / §25 / §26. [rows] are the person's OTHER counted deliveries (sending or
 * sent). Returns the first cap that is exceeded, or null.
 */
function capViolation(rows, creatorId, now, cfg) {
  const inLast = ms => rows.filter(r => new Date(r.claimedAt).getTime() >= now - ms);
  if (inLast(HOUR).length >= cfg.capHour) return 'cap_hour';
  if (inLast(DAY).length >= cfg.capDay) return 'cap_day';
  if (inLast(cfg.creatorMs).some(r => same(r.creatorId, creatorId))) return 'cap_creator';
  return null;
}

// Why a person can no longer be notified, or null. Pure; [u] is a lean User.
function accountIssue(u, now) {
  if (!u) return 'user_missing';
  if (u.status !== 'ACTIVE') return 'not_active';
  if (isSuspended(u, now)) return 'suspended';
  if (!isVerified(u)) return 'unverified';
  if (pushOff(u)) return 'push_disabled';
  if (nearbyOff(u)) return 'nearby_disabled';
  if (capableTokens(u).length === 0) return 'no_capable_device';
  return null;
}


// ── Plan gates ────────────────────────────────────────────────────────────────
const PLAN_FIELDS = 'creatorId sportType customSportName startTime endTime location playerLimit playersJoined kickedPlayers cardStatus createdAt';

/**
 * 5A §13: the plan is still worth announcing — open, not full, starting at least
 * the lead time from now. (The creation window and the rollout time are an ENTRY
 * gate only: they decide whether a plan is picked up, not whether a pass stops.)
 */
function planStillQualifies(planId, now, cfg) {
  return SportsPlan.findOne({
    _id: planId,
    cardStatus: 'open',
    startTime: { $gte: new Date(now + cfg.minLeadMs) },
    $expr: { $lt: [{ $size: { $ifNull: ['$playersJoined', []] } }, '$playerLimit'] },
  }).select(PLAN_FIELDS).lean();
}

// ── Selection (done ONCE per plan) ────────────────────────────────────────────
const CANDIDATE_FIELDS = [
  '_id', 'blockedUsers', 'status', 'suspensionInfo.isSuspended', 'suspensionInfo.suspendedUntil',
  'verified', 'photoVerificationStatus',
  'notifications.pushNotifications', 'notifications.nearbyActivities',
  'liveLocation.updatedAt',                 // never the coordinates
  'fcmDevices.token', 'fcmDevices.supportsSportsDiscovery',
  'questionnaire.hobbies', 'questionnaire.humrahRoomInterests', 'questionnaire.conversationInterests',
].join(' ');

/**
 * The nearest eligible people for a plan (5A §29–§30 steps 3–11). Batched: one
 * query per rule, never one per candidate. Returns { recipients: [ObjectId], stats }.
 * Nothing about position leaves this function except the ORDER (nearest first).
 */
async function selectRecipients(plan, now, cfg) {
  const stats = { candidates: 0, eligible: 0, selected: 0 };
  const creator = await User.findById(plan.creatorId).select('_id blockedUsers').lean();
  if (!creator) return { recipients: [], stats };

  // Blocks, both directions, in one query (the existing Sports helper).
  const blocked = await plans()._internal.blockedCounterparts(creator);
  const exclude = [plan.creatorId, ...(plan.playersJoined || []), ...(plan.kickedPlayers || []), ...blocked];

  const coords = plan.location && plan.location.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite)) return { recipients: [], stats };

  const cutoff = new Date(now - cfg.freshMs);
  const candidates = await User.find({
    _id: { $nin: exclude },
    liveLocation: { $near: { $geometry: { type: 'Point', coordinates: [coords[0], coords[1]] }, $maxDistance: cfg.radiusKm * 1000 } },
    'liveLocation.updatedAt': { $gte: cutoff },
    status: 'ACTIVE',
    'notifications.pushNotifications': { $ne: false },
    'notifications.nearbyActivities': { $ne: false },
    $and: [
      { $or: [{ verified: true }, { photoVerificationStatus: 'approved' }] },
      { $or: [{ 'suspensionInfo.isSuspended': { $ne: true } }, { 'suspensionInfo.suspendedUntil': { $lte: new Date(now) } }] },
    ],
    fcmDevices: { $elemMatch: { supportsSportsDiscovery: true, token: { $type: 'string', $gt: '' } } },
  }).select(CANDIDATE_FIELDS).limit(cfg.maxCandidates).maxTimeMS(5000).lean();
  stats.candidates = candidates.length;

  // The query is the fast path; the same rules are applied again here in code, so a
  // change to one can never silently loosen the other.
  let pool = candidates.filter(u => accountIssue(u, now) === null
    && u.liveLocation && u.liveLocation.updatedAt && new Date(u.liveLocation.updatedAt).getTime() >= cutoff.getTime());
  if (pool.length === 0) return { recipients: [], stats };

  // Interest (5A §5B) in code; participation (§5C) for the rest, in ONE query.
  const interested = new Set(pool.filter(u => hasSportsInterest(u.questionnaire)).map(u => String(u._id)));
  const others = pool.filter(u => !interested.has(String(u._id))).map(u => u._id);
  const participated = new Set();
  if (others.length > 0) {
    const otherSet = new Set(others.map(String));
    const past = await SportsPlan.find({
      playersJoined: { $in: others },
      startTime: { $gte: new Date(now - cfg.participationMs) },
    }).select('playersJoined').lean();
    for (const p of past) for (const id of p.playersJoined || []) if (otherSet.has(String(id))) participated.add(String(id));
  }
  pool = pool.filter(u => interested.has(String(u._id)) || participated.has(String(u._id)));
  if (pool.length === 0) return { recipients: [], stats };

  // Overlapping non-cancelled plans (5A §10), in ONE query.
  const ids = pool.map(u => u._id);
  const idSet = new Set(ids.map(String));
  const clashing = new Set();
  const overlap = await SportsPlan.find({
    _id: { $ne: plan._id },
    playersJoined: { $in: ids },
    cardStatus: { $ne: 'cancelled' },
    startTime: { $lt: plan.endTime },
    endTime: { $gt: plan.startTime },
  }).select('playersJoined').lean();
  for (const p of overlap) for (const id of p.playersJoined || []) if (idSet.has(String(id))) clashing.add(String(id));
  pool = pool.filter(u => !clashing.has(String(u._id)));

  // Caps, cooldowns and "already invited to this plan" (5A §15–§16), in ONE query.
  const rows = await SportsDiscoveryDelivery.find({
    userId: { $in: pool.map(u => u._id) },
    claimedAt: { $gte: new Date(now - Math.max(CAP_LOOKBACK_MS, cfg.creatorMs)) },
  }).select('userId creatorId sportsPlanId status claimedAt').lean();
  const byUser = new Map();
  for (const r of rows) {
    const k = String(r.userId);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(r);
  }
  pool = pool.filter(u => {
    const mine = byUser.get(String(u._id)) || [];
    if (mine.some(r => same(r.sportsPlanId, plan._id))) return false;
    return capViolation(mine.filter(r => SportsDiscoveryDelivery.COUNTED.includes(r.status)), plan.creatorId, now, cfg) === null;
  });
  stats.eligible = pool.length;

  // Nearest first is already the order $near returned; no scoring of any kind.
  const recipients = pool.slice(0, cfg.maxRecipients).map(u => u._id);
  stats.selected = recipients.length;
  return { recipients, stats };
}

// ── Per-recipient send ────────────────────────────────────────────────────────
function makePayload(plan, userId, now) {
  const spotsLeft = Math.max(0, (plan.playerLimit || 0) - (plan.playersJoined || []).length);
  const sport = chat().sportName(plan);
  return {
    type: TYPE,
    sportsPlanId: String(plan._id),
    sportType: plan.sportType,
    startTime: new Date(plan.startTime).toISOString(),
    spotsLeft: String(spotsLeft),
    recipientUserId: String(userId),
    title: `${sport} plan near you`,
    body: `A ${sport.toLowerCase()} game is being planned nearby. Tap to see the details.`,
  };
}

const countedRowsOf = (userId, sinceMs, excludeRowId) => SportsDiscoveryDelivery.find({
  userId,
  status: { $in: SportsDiscoveryDelivery.COUNTED },
  claimedAt: { $gte: new Date(sinceMs) },
  ...(excludeRowId ? { _id: { $ne: excludeRowId } } : {}),
}).select('creatorId claimedAt').lean();

/**
 * Everything that must still be true right before a push (5A §13):
 * the plan, the person, the block pair, their preferences, their device and the
 * caps. Returns { ok:true, plan, user } or { ok:false, reason, stop }.
 * [stop] = the whole plan should stop (it no longer qualifies).
 */
async function recheck(planId, userId, creatorId, now, cfg, excludeRowId) {
  const plan = await planStillQualifies(planId, now, cfg);
  if (!plan) return { ok: false, reason: 'plan_no_longer_eligible', stop: true };
  if (includesId(plan.playersJoined, userId)) return { ok: false, reason: 'now_a_member' };
  if (includesId(plan.kickedPlayers, userId)) return { ok: false, reason: 'removed_from_plan' };

  const [user, creator] = await Promise.all([
    User.findById(userId).select(CANDIDATE_FIELDS).lean(),
    User.findById(creatorId).select('_id blockedUsers').lean(),
  ]);
  const issue = accountIssue(user, now);
  if (issue) return { ok: false, reason: issue };
  if (!creator) return { ok: false, reason: 'creator_missing' };
  if (blockedEitherWay(user, creator)) return { ok: false, reason: 'blocked_pair' };

  const others = await countedRowsOf(userId, now - Math.max(CAP_LOOKBACK_MS, cfg.creatorMs), excludeRowId);
  const cap = capViolation(others, creatorId, now, cfg);
  if (cap) return { ok: false, reason: cap };
  return { ok: true, plan, user };
}

/**
 * Cap race (5B §16, refined). Two servers can process two DIFFERENT plans for the
 * same person at the same moment; each passes the read above. So after inserting,
 * each re-counts everyone ELSE's counted rows. Insert-then-read means at least one
 * of two racers sees the other, so two can never both send. (If both see each
 * other both skip: an extremely rare miss, which 5A prefers to a second push.)
 */
async function lostCapRace(row, cfg, now) {
  const others = await countedRowsOf(row.userId, now - Math.max(CAP_LOOKBACK_MS, cfg.creatorMs), row._id);
  return capViolation(others, row.creatorId, now, cfg) !== null;
}

/** Sends for an already-inserted (or retry-claimed) row and records the outcome. */
async function sendAndRecord(row, plan, user, cfg, now, { retry }) {
  let res;
  try {
    res = await fcm().sendDataFcm(row.userId, capableTokens(user), makePayload(plan, row.userId, now));
  } catch (_) {
    // Unknown outcome: it may have gone out. The row stays 'sending' and is never resent.
    return 'send_error';
  }
  if (res && res.delivered) {
    await SportsDiscoveryDelivery.updateOne({ _id: row._id, status: 'sending' }, { $set: { status: 'sent', sentAt: new Date(now) } });
    return 'sent';
  }
  if (retry) {
    await SportsDiscoveryDelivery.updateOne({ _id: row._id, status: 'sending' }, { $set: { status: 'failed' } });
    return 'failed';
  }
  await SportsDiscoveryDelivery.updateOne({ _id: row._id, status: 'sending' }, {
    $set: { status: 'failed_retryable', retryAfter: new Date(now + RETRY_DELAY_MS), retryUntil: new Date(row.claimedAt.getTime() + cfg.retryWindowMs) },
  });
  return 'failed_retryable';
}

const skipRow = (row, reason) => SportsDiscoveryDelivery.updateOne(
  { _id: row._id, status: 'sending' }, { $set: { status: 'skipped', skipReason: reason } });

/** One first-time push for (plan, user). Returns an outcome word. */
async function deliverOne(planId, creatorId, userId, clock, cfg) {
  if (await SportsDiscoveryDelivery.exists({ sportsPlanId: planId, userId })) return 'already_invited';
  const now = clock();
  const check = await recheck(planId, userId, creatorId, now, cfg, null);
  if (!check.ok) return check.stop ? 'STOP' : check.reason;

  let row;
  try {
    row = await SportsDiscoveryDelivery.create({
      sportsPlanId: planId, userId, creatorId, status: 'sending', claimedAt: new Date(now), attempts: 1,
    });
  } catch (err) {
    if (err && err.code === 11000) return 'already_invited';
    throw err;
  }
  if (await lostCapRace(row, cfg, now)) { await skipRow(row, 'cap_race'); return 'cap_race'; }
  return sendAndRecord(row, check.plan, check.user, cfg, now, { retry: false });
}

// ── Retry pass (5A §16): one retry, within the window, only if still eligible ──
async function retryPass(clock, cfg, summary) {
  const now = clock();
  // Windows that lapsed are final.
  const lapsed = await SportsDiscoveryDelivery.updateMany(
    { status: 'failed_retryable', retryUntil: { $lte: new Date(now) } }, { $set: { status: 'failed' } });
  summary.failed += lapsed.modifiedCount || 0;

  const due = await SportsDiscoveryDelivery.find({
    status: 'failed_retryable', retryAfter: { $lte: new Date(now) }, retryUntil: { $gt: new Date(now) },
  }).sort({ retryAfter: 1 }).limit(cfg.maxRecipients * 2).select('_id').lean();

  for (const { _id } of due) {
    try {
      const t = clock();
      const row = await SportsDiscoveryDelivery.findOneAndUpdate(
        { _id, status: 'failed_retryable', retryAfter: { $lte: new Date(t) }, retryUntil: { $gt: new Date(t) } },
        { $set: { status: 'sending', attempts: 2 } }, { new: true }).lean();
      if (!row) continue;                               // someone else took it
      summary.retried++;
      const check = await recheck(row.sportsPlanId, row.userId, row.creatorId, t, cfg, row._id);
      if (!check.ok) { await skipRow(row, check.reason); tally(summary, check.reason); continue; }
      if (await lostCapRace(row, cfg, t)) { await skipRow(row, 'cap_race'); tally(summary, 'cap_race'); continue; }
      tally(summary, await sendAndRecord(row, check.plan, check.user, cfg, t, { retry: true }));
    } catch (err) {
      summary.errors++;
      console.error(`[SPORTS_DISCOVERY] retry failed: ${err && err.name}`);
    }
  }
}

function tally(summary, outcome) {
  if (outcome === 'sent') summary.sent++;
  else if (outcome === 'failed' || outcome === 'failed_retryable' || outcome === 'send_error') summary.failed++;
  else summary.skipped[outcome] = (summary.skipped[outcome] || 0) + 1;
}

// ── Plan claim (5B §7) ────────────────────────────────────────────────────────
async function claimRun(planId, now, cfg) {
  try {
    await SportsDiscoveryRun.updateOne(
      { sportsPlanId: planId },
      { $setOnInsert: { status: 'processing', leaseUntil: new Date(0), attempts: 0 } },
      { upsert: true });
  } catch (err) {
    if (!err || err.code !== 11000) throw err;   // two workers upserting at once: fine
  }
  return SportsDiscoveryRun.findOneAndUpdate(
    { sportsPlanId: planId, status: 'processing', attempts: { $lt: MAX_ATTEMPTS }, leaseUntil: { $lte: new Date(now) } },
    { $set: { leaseUntil: new Date(now + cfg.leaseMs) }, $inc: { attempts: 1 } },
    { new: true }).lean();
}

const finishRun = (run, reason, tallies) => SportsDiscoveryRun.updateOne(
  { _id: run._id, status: 'processing', attempts: run.attempts },   // only the claim that owns it
  { $set: { status: 'done', doneReason: reason, leaseUntil: null },
    $inc: { 'counts.sent': tallies.sent, 'counts.failed': tallies.failed, 'counts.skipped': tallies.skippedTotal } });

/** One claimed run: choose the recipients once, then walk them. */
async function processRun(run, planDoc, clock, cfg, summary) {
  const tallies = { sent: 0, failed: 0, skippedTotal: 0 };
  const count = outcome => {
    const before = { sent: summary.sent, failed: summary.failed };
    tally(summary, outcome);
    tallies.sent += summary.sent - before.sent;
    tallies.failed += summary.failed - before.failed;
    if (outcome !== 'sent' && outcome !== 'failed' && outcome !== 'failed_retryable' && outcome !== 'send_error') tallies.skippedTotal++;
  };

  let recipients = run.recipients || [];
  if (!run.selectedAt) {
    if (!(await planStillQualifies(planDoc._id, clock(), cfg))) {
      await finishRun(run, 'plan_ineligible', tallies);
      return;
    }
    const picked = await selectRecipients(planDoc, clock(), cfg);
    summary.candidates += picked.stats.candidates;
    summary.eligible += picked.stats.eligible;
    summary.selected += picked.stats.selected;
    // Stored once. If another claim stored first, theirs is the list.
    const stored = await SportsDiscoveryRun.findOneAndUpdate(
      { _id: run._id, selectedAt: null },
      { $set: { recipients: picked.recipients, selectedAt: new Date(clock()), 'counts.candidates': picked.stats.candidates, 'counts.eligible': picked.stats.eligible, 'counts.selected': picked.stats.selected } },
      { new: true }).lean();
    recipients = stored ? stored.recipients : (await SportsDiscoveryRun.findById(run._id).select('recipients').lean()).recipients;
    if (recipients.length === 0) { await finishRun(run, 'no_recipients', tallies); return; }
  }

  for (const userId of recipients) {
    if (clock() >= new Date(run.leaseUntil).getTime() - 5 * SEC) return;   // lease nearly gone: the next claim resumes
    let outcome;
    try {
      outcome = await deliverOne(planDoc._id, planDoc.creatorId, userId, clock, cfg);
    } catch (err) {
      summary.errors++;
      console.error(`[SPORTS_DISCOVERY] send step failed: ${err && err.name}`);
      continue;
    }
    if (outcome === 'STOP') { await finishRun(run, 'plan_ineligible', tallies); return; }
    count(outcome);
  }
  await finishRun(run, 'completed', tallies);
}

// ── The tick ──────────────────────────────────────────────────────────────────
async function runTick(nowOverride = null) {
  const clock = () => (nowOverride !== null ? nowOverride : Date.now());
  const summary = { plans: 0, candidates: 0, eligible: 0, selected: 0, sent: 0, failed: 0, retried: 0, errors: 0, skipped: {} };
  const cfg = config();

  if (!cfg.enabled) return { ...summary, disabled: true };
  if (cfg.startedAt === null) {
    // Fail closed: enabling without saying WHEN starts nothing.
    warnOnce('no-start', 'SPORTS_DISCOVERY_ENABLED is on but SPORTS_DISCOVERY_STARTED_AT is missing or not a valid time; discovery is not running.');
    return { ...summary, disabled: true, reason: 'no_start_marker' };
  }

  const began = Date.now();
  await retryPass(clock, cfg, summary).catch(err => { summary.errors++; console.error(`[SPORTS_DISCOVERY] retry pass failed: ${err && err.name}`); });

  const now = clock();
  // Runs that were claimed before and whose worker never finished: give up after
  // the claim cap, otherwise resume them (the recipient list is already stored).
  await SportsDiscoveryRun.updateMany(
    { status: 'processing', attempts: { $gte: MAX_ATTEMPTS }, leaseUntil: { $lte: new Date(now) } },
    { $set: { status: 'done', doneReason: 'abandoned', leaseUntil: null } });
  const resumable = await SportsDiscoveryRun.find({
    status: 'processing', attempts: { $gt: 0, $lt: MAX_ATTEMPTS }, leaseUntil: { $lte: new Date(now) },
  }).sort({ createdAt: 1 }).limit(cfg.maxPlansPerTick).select('sportsPlanId').lean();

  // New plans: open, not full, far enough away, created inside the window and after
  // the rollout time. Oldest first. A few more than the limit are read so plans that
  // are already done or leased don't crowd out new ones.
  const since = new Date(Math.max(now - cfg.windowMs, cfg.startedAt));
  const fresh = await SportsPlan.find({
    cardStatus: 'open',
    startTime: { $gte: new Date(now + cfg.minLeadMs) },
    createdAt: { $gte: since },
    $expr: { $lt: [{ $size: { $ifNull: ['$playersJoined', []] } }, '$playerLimit'] },
  }).sort({ createdAt: 1 }).limit(cfg.maxPlansPerTick * 5).select('_id').lean();

  const wanted = [...new Set([...resumable.map(r => String(r.sportsPlanId)), ...fresh.map(p => String(p._id))])];
  if (wanted.length > 0) {
    const runs = await SportsDiscoveryRun.find({ sportsPlanId: { $in: wanted.map(id => new ObjectId(id)) } })
      .select('sportsPlanId status leaseUntil attempts').lean();
    const byPlan = new Map(runs.map(r => [String(r.sportsPlanId), r]));
    const todo = wanted.filter(id => {
      const r = byPlan.get(id);
      return !r || (r.status === 'processing' && r.attempts < MAX_ATTEMPTS && new Date(r.leaseUntil).getTime() <= now);
    }).slice(0, cfg.maxPlansPerTick);

    for (const id of todo) {
      if (Date.now() - began > TICK_BUDGET_MS) break;
      try {
        const run = await claimRun(new ObjectId(id), clock(), cfg);
        if (!run) continue;                                     // another worker has it, or it is done
        summary.plans++;
        const planDoc = await SportsPlan.findById(id).select(PLAN_FIELDS).lean();
        if (!planDoc) { await finishRun(run, 'plan_ineligible', { sent: 0, failed: 0, skippedTotal: 0 }); continue; }
        await processRun(run, planDoc, clock, cfg, summary);
      } catch (err) {
        summary.errors++;
        console.error(`[SPORTS_DISCOVERY] plan failed: ${err && err.name}`);
      }
    }
  }

  if (summary.plans || summary.retried || summary.errors) {
    const skipped = Object.entries(summary.skipped).map(([k, v]) => `${k}=${v}`).join(',') || 'none';
    console.log(`[SPORTS_DISCOVERY] tick plans=${summary.plans} candidates=${summary.candidates} eligible=${summary.eligible} selected=${summary.selected} sent=${summary.sent} failed=${summary.failed} retried=${summary.retried} errors=${summary.errors} skipped=${skipped}`);
  }
  return summary;
}

// One tick at a time per process. node-cron does not wait for a slow tick, so without
// this two ticks of one server could work on different plans for the same people at
// once (the cap race below would still stop a double send, but could leave both
// unsent). Other servers are separate processes and are covered by the claims.
let ticking = false;
async function tickSportsDiscovery(nowOverride = null) {
  if (ticking) return { overlapped: true, plans: 0, sent: 0, errors: 0 };
  ticking = true;
  try { return await runTick(nowOverride); } finally { ticking = false; }
}

module.exports = {
  tickSportsDiscovery,
  _internal: {
    runTick, config, envBool, envInt, hasSportsInterest, isVerified, isSuspended, capableTokens, blockedEitherWay,
    capViolation, accountIssue, makePayload, selectRecipients, claimRun, INTEREST_LABELS, TYPE, MAX_ATTEMPTS,
    RETRY_DELAY_MS,
  },
};
