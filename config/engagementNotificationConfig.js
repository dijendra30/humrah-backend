// config/engagementNotificationConfig.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications (Phase 1) — every tunable in one place.
//
// Read on every use (no caching), so a test can change process.env between calls.
// Convention (ROOM_ENGAGEMENT_ENABLED / SPORTS_DISCOVERY_*): unset or blank = the
// default; a value that is not usable = the default, never something looser.
//
// SAFE DEFAULT: ENGAGEMENT_WORKER_ENABLED is false. Unless an operator sets it to
// "true", nothing is planned, queued or sent.
// -----------------------------------------------------------------------------
'use strict';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const CATEGORIES = Object.freeze([
  'NEARBY', 'COMMUNITY', 'SPORTS', 'ROOMS', 'SOCIAL', 'INFORMATIVE', 'FUNNY', 'SEASONAL',
]);

// Data-backed categories are on by default. The catalog categories (no live event
// behind them) stay off until an operator approves content and enables them.
const DEFAULT_ENABLED_CATEGORIES = Object.freeze(['NEARBY', 'COMMUNITY', 'SPORTS', 'ROOMS']);

// Higher = preferred when two opportunities are otherwise equally relevant.
const DEFAULT_PRIORITIES = Object.freeze({
  SPORTS: 90, ROOMS: 80, COMMUNITY: 75, NEARBY: 70,
  SEASONAL: 50, SOCIAL: 45, INFORMATIVE: 40, FUNNY: 30,
});

const warned = new Set();
function warnOnce(key, text) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[ENGAGEMENT] ${text}`);
}

const raw = name => {
  const v = process.env[name];
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
};

function envBool(name, def) {
  const v = raw(name);
  if (v === null) return def;
  return v.toLowerCase() === 'true';
}

function envInt(name, def, min, max) {
  const v = raw(name);
  if (v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    warnOnce(`int:${name}`, `${name} must be a whole number from ${min} to ${max}; using ${def}.`);
    return def;
  }
  return n;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function envHHMM(name, def) {
  const v = raw(name);
  if (v === null) return def;
  if (!HHMM.test(v)) {
    warnOnce(`hhmm:${name}`, `${name} must look like 22:00; using ${def}.`);
    return def;
  }
  return v;
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

function envCategories(name, def) {
  const v = raw(name);
  if (v === null) return [...def];
  if (v.toLowerCase() === 'none') return [];
  const list = v.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const bad = list.filter(c => !CATEGORIES.includes(c));
  if (bad.length) warnOnce(`cat:${name}`, `${name} has unknown categories (${bad.join(', ')}); they are ignored.`);
  return [...new Set(list.filter(c => CATEGORIES.includes(c)))];
}

// "SPORTS:90,ROOMS:80" — unknown or out-of-range entries keep their default.
function envPriorities(name) {
  const out = { ...DEFAULT_PRIORITIES };
  const v = raw(name);
  if (v === null) return out;
  for (const part of v.split(',')) {
    const [k, n] = part.split(':').map(s => (s || '').trim());
    const cat = (k || '').toUpperCase();
    const num = Number(n);
    if (CATEGORIES.includes(cat) && Number.isInteger(num) && num >= 0 && num <= 1000) out[cat] = num;
    else warnOnce(`prio:${part}`, `${name} entry "${part}" ignored.`);
  }
  return out;
}

// "60,300,900" seconds between attempts 1→2, 2→3, 3→4.
function envDelays(name, def) {
  const v = raw(name);
  if (v === null) return [...def];
  const list = v.split(',').map(s => Number(s.trim()));
  if (list.length === 0 || list.some(n => !Number.isInteger(n) || n < 1 || n > 24 * 3600)) {
    warnOnce(`delays:${name}`, `${name} must be comma-separated seconds (1..86400); using the default.`);
    return [...def];
  }
  return list;
}

function get() {
  const tz = raw('ENGAGEMENT_DEFAULT_TIMEZONE');
  const defaultTimeZone = tz && isValidTimeZone(tz) ? tz : 'Asia/Kolkata';
  if (tz && !isValidTimeZone(tz)) warnOnce('tz', `ENGAGEMENT_DEFAULT_TIMEZONE "${tz}" is not a known time zone; using Asia/Kolkata.`);

  return {
    // Master switches
    enabled:        envBool('ENGAGEMENT_WORKER_ENABLED', false),
    plannerEnabled: envBool('ENGAGEMENT_PLANNER_ENABLED', true),
    queueEnabled:   envBool('ENGAGEMENT_QUEUE_ENABLED', true),

    // Scheduling and batching
    intervalMs:        envInt('ENGAGEMENT_INTERVAL_SECONDS', 300, 30, 24 * 3600) * 1000,
    batchSize:         envInt('ENGAGEMENT_BATCH_SIZE', 100, 1, 1000),
    maxBatchesPerTick: envInt('ENGAGEMENT_MAX_BATCHES_PER_TICK', 3, 1, 50),
    maxSendsPerTick:   envInt('ENGAGEMENT_MAX_SENDS_PER_TICK', 100, 1, 5000),
    cycleRestMs:       envInt('ENGAGEMENT_CYCLE_REST_MINUTES', 360, 0, 7 * 24 * 60) * MIN,
    leaseMs:           envInt('ENGAGEMENT_LEASE_SECONDS', 240, 30, 3600) * 1000,
    claimLeaseMs:      envInt('ENGAGEMENT_CLAIM_LEASE_SECONDS', 120, 15, 3600) * 1000,
    orphanReservationMs: envInt('ENGAGEMENT_ORPHAN_RESERVATION_MINUTES', 15, 1, 24 * 60) * MIN,

    // Frequency
    frequencyWindowMs: envInt('ENGAGEMENT_FREQUENCY_HOURS', 72, 24, 24 * 30) * HOUR,

    // Retries
    maxAttempts:    envInt('ENGAGEMENT_MAX_ATTEMPTS', 4, 1, 10),
    retryDelaysSec: envDelays('ENGAGEMENT_RETRY_DELAYS_SECONDS', [60, 300, 900]),
    maxDeferMs:     envInt('ENGAGEMENT_MAX_DEFER_HOURS', 36, 1, 7 * 24) * HOUR,

    // Quiet hours (system window, on top of the user's own)
    systemQuietEnabled: envBool('ENGAGEMENT_QUIET_HOURS_ENABLED', true),
    systemQuietStart:   envHHMM('ENGAGEMENT_QUIET_START', '22:00'),
    systemQuietEnd:     envHHMM('ENGAGEMENT_QUIET_END', '08:00'),
    defaultTimeZone,

    // Categories and scoring
    enabledCategories: envCategories('ENGAGEMENT_CATEGORIES_ENABLED', DEFAULT_ENABLED_CATEGORIES),
    priorities:        envPriorities('ENGAGEMENT_CATEGORY_PRIORITIES'),
    sameCategoryPenalty: 0.8,   // last notification had the same category
    openedCategoryBoost: 1.1,   // the user opened a notification of this category before

    // Opportunity sources
    radiusKm:              envInt('ENGAGEMENT_RADIUS_KM', 10, 1, 50),
    locationMaxAgeMs:      envInt('ENGAGEMENT_LOCATION_MAX_AGE_DAYS', 30, 1, 365) * DAY,
    newMembersLookbackMs:  envInt('ENGAGEMENT_NEW_MEMBERS_DAYS', 7, 1, 60) * DAY,
    newMembersMinCount:    envInt('ENGAGEMENT_NEW_MEMBERS_MIN', 3, 2, 1000),
    sportsMinLeadMs:       envInt('ENGAGEMENT_SPORTS_MIN_LEAD_MINUTES', 120, 15, 24 * 60) * MIN,
    sportsMaxLeadMs:       envInt('ENGAGEMENT_SPORTS_MAX_LEAD_HOURS', 72, 1, 14 * 24) * HOUR,
    roomActiveWithinMs:    envInt('ENGAGEMENT_ROOM_ACTIVE_HOURS', 48, 1, 14 * 24) * HOUR,
    questionMaxAgeMs:      envInt('ENGAGEMENT_QUESTION_MAX_AGE_HOURS', 18, 1, 24) * HOUR,
    questionMinRemainingMs: envInt('ENGAGEMENT_QUESTION_MIN_REMAINING_HOURS', 3, 1, 23) * HOUR,
  };
}

module.exports = {
  get,
  CATEGORIES,
  DEFAULT_ENABLED_CATEGORIES,
  DEFAULT_PRIORITIES,
  isValidTimeZone,
  HHMM,
  _internal: { envBool, envInt, envHHMM, envCategories, envPriorities, envDelays, warned },
};
