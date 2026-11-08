// services/appUpdates/appUpdatePolicy.js
// -----------------------------------------------------------------------------
// App Update Management — the rules, as pure functions (no database, unit-tested).
//
// THE DECISION (decideUpdate)
//   The server decides; the app only shows what it is told.
//   • installed < minimumSupportedVersionCode  → MANDATORY (blocking). Never held back by
//     the rollout percentage: a client below the minimum is unsupported, and leaving it
//     unprotected because of a staged rollout would defeat the minimum (documented policy).
//   • installed < latest versionCode           → the release's policy (OPTIONAL /
//     RECOMMENDED / CRITICAL), but only for users inside the rollout percentage.
//   • installed ≥ latest                       → nothing. Above latest is never told to
//     "update" to an older build; it is flagged (aheadOfLatest) for compatibility review.
//   Comparisons use the numeric versionCode only; versionName is display text.
//
// ROLLOUT (rolloutBucket)
//   sha256(releaseId:stableId) → 0..99. The same user always lands in the same bucket for
//   a release, so raising 10 % → 25 % only adds people; nobody flips in and out.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');

const MAX_VERSION_CODE = 2100000000;
const POLICIES = ['OPTIONAL', 'RECOMMENDED', 'CRITICAL'];
const ROLLOUT_STEPS = [10, 25, 50, 75, 100];
const DEFAULT_PACKAGE = 'in.humrah.app';
const CHECK_AGAIN_SECONDS = 6 * 60 * 60;

const androidPackage = () => {
  const p = (process.env.APP_ANDROID_PACKAGE || DEFAULT_PACKAGE).trim();
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(p) ? p : DEFAULT_PACKAGE;
};

const canonicalPlayStoreUrl = (pkg = androidPackage()) => `https://play.google.com/store/apps/details?id=${pkg}`;

/** A positive integer versionCode, or null. Accepts "21" or 21; refuses 21.5, "21abc", 0, huge. */
function parseVersionCode(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 1 && raw <= MAX_VERSION_CODE ? raw : null;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= MAX_VERSION_CODE ? n : null;
}

/** versionName is display text: digits, letters, dots, dashes, plus, underscore; ≤ 32. */
function parseVersionName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return /^[0-9A-Za-z][0-9A-Za-z.\-+_]{0,31}$/.test(s) ? s : null;
}

/**
 * Only the official Play listing of THIS app: https, play.google.com, /store/apps/details,
 * id = the configured package, nothing else that could redirect. Returns the canonical URL
 * or null.
 */
function validatePlayStoreUrl(raw, pkg = androidPackage()) {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let u;
  try { u = new URL(raw.trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.port) return null;
  if (u.hostname !== 'play.google.com') return null;
  if (u.pathname !== '/store/apps/details') return null;
  const id = u.searchParams.get('id');
  if (id !== pkg) return null;
  for (const key of u.searchParams.keys()) if (!['id', 'hl', 'gl'].includes(key)) return null;
  return canonicalPlayStoreUrl(pkg);
}

/** 0..99, stable for (release, person). */
function rolloutBucket(releaseId, stableId) {
  const h = crypto.createHash('sha256').update(`${releaseId}:${stableId}`).digest();
  return h.readUInt32BE(0) % 100;
}

function inRollout(release, stableId) {
  const pct = release.rolloutPercentage;
  if (pct >= 100) return true;
  if (!stableId) return false;          // no stable identity: only full rollouts reach it
  return rolloutBucket(String(release._id), String(stableId)) < pct;
}

/**
 * What the installed app should do. `release` is the live (PUBLISHED) release or null.
 * Returns { updateType, updateAvailable, updateRequired, aheadOfLatest, heldByRollout }.
 */
function decideUpdate({ installedVersionCode, release, stableId }) {
  const none = { updateType: 'NONE', updateAvailable: false, updateRequired: false, aheadOfLatest: false, heldByRollout: false };
  if (!release) return none;
  const installed = installedVersionCode;
  if (installed < release.minimumSupportedVersionCode) {
    return { ...none, updateType: 'MANDATORY', updateAvailable: true, updateRequired: true };
  }
  if (installed > release.versionCode) return { ...none, aheadOfLatest: true };
  if (installed === release.versionCode) return none;
  if (!inRollout(release, stableId)) return { ...none, heldByRollout: true };
  const policy = POLICIES.includes(release.updatePolicy) ? release.updatePolicy : 'OPTIONAL';
  return { ...none, updateType: policy, updateAvailable: true };
}

/** The Android response: only published configuration, nothing internal. */
function clientResponse(decision, release, pkg = androidPackage()) {
  const base = {
    success: true,
    updateAvailable: decision.updateAvailable,
    updateRequired: decision.updateRequired,
    updateType: decision.updateType,
    checkAgainAfterSeconds: CHECK_AGAIN_SECONDS,
  };
  if (!decision.updateAvailable || !release) return base;
  return {
    ...base,
    releaseId: String(release._id),
    latestVersion: { versionName: release.versionName, versionCode: release.versionCode },
    minimumSupportedVersionCode: release.minimumSupportedVersionCode,
    title: release.releaseTitle,
    message: release.releaseDescription || '',
    releaseNotes: Array.isArray(release.releaseNotes) ? release.releaseNotes : [],
    playStoreUrl: validatePlayStoreUrl(release.playStoreUrl, pkg) || canonicalPlayStoreUrl(pkg),
    // A mandatory update can never be postponed, whatever the release says.
    allowPostponement: decision.updateRequired ? false : release.allowPostponement !== false,
    reminderCooldownHours: release.reminderCooldownHours,
    maxReminders: release.maxReminders,
  };
}

// ── Admin input ───────────────────────────────────────────────────────────────

const EDITABLE_ALWAYS = ['releaseTitle', 'releaseDescription', 'releaseNotes', 'updatePolicy', 'rolloutPercentage',
  'minimumSupportedVersionCode', 'playStoreUrl', 'reminderCooldownHours', 'maxReminders', 'allowPostponement'];
const EDITABLE_BEFORE_PUBLISH = ['versionName', 'versionCode', 'scheduledAt', 'scheduleTimeZone'];

const isTimeZone = tz => {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
};

/**
 * Whitelists and validates an admin payload (create or patch). Unknown keys are ignored
 * (no mass assignment). Returns { values } or { errors: [{ field, message }] }.
 * `existing` is the stored release when patching; `allowed` the keys this status may change.
 */
function readReleaseInput(body, { existing = null, allowed = [...EDITABLE_ALWAYS, ...EDITABLE_BEFORE_PUBLISH], pkg = androidPackage() } = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const values = {};
  const errors = [];
  const err = (field, message) => errors.push({ field, message });
  const has = k => Object.prototype.hasOwnProperty.call(src, k) && allowed.includes(k);

  if (has('versionName')) {
    const v = parseVersionName(src.versionName);
    if (!v) err('versionName', 'Version name: letters, digits, dots or dashes (max 32), e.g. 19.2.6.'); else values.versionName = v;
  }
  if (has('versionCode')) {
    const v = parseVersionCode(src.versionCode);
    if (v == null) err('versionCode', 'Version code must be a whole number from 1 to 2100000000 (Android versionCode).'); else values.versionCode = v;
  }
  if (has('minimumSupportedVersionCode')) {
    const v = parseVersionCode(src.minimumSupportedVersionCode);
    if (v == null) err('minimumSupportedVersionCode', 'Minimum supported version code must be a whole number from 1.'); else values.minimumSupportedVersionCode = v;
  }
  if (has('releaseTitle')) {
    const v = typeof src.releaseTitle === 'string' ? src.releaseTitle.trim() : '';
    if (v.length < 3 || v.length > 80) err('releaseTitle', 'Title: 3–80 characters.'); else values.releaseTitle = v;
  }
  if (has('releaseDescription')) {
    const v = typeof src.releaseDescription === 'string' ? src.releaseDescription.trim() : '';
    if (v.length > 300) err('releaseDescription', 'Description: at most 300 characters.'); else values.releaseDescription = v;
  }
  if (has('releaseNotes')) {
    const raw = Array.isArray(src.releaseNotes) ? src.releaseNotes
      : typeof src.releaseNotes === 'string' ? src.releaseNotes.split(/\r?\n/) : null;
    if (!raw) err('releaseNotes', 'Release notes must be a list of lines.');
    else {
      const notes = raw.filter(n => typeof n === 'string').map(n => n.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
      if (notes.length > 20) err('releaseNotes', 'At most 20 release-note lines.');
      else if (notes.some(n => n.length > 200)) err('releaseNotes', 'Each release-note line: at most 200 characters.');
      else values.releaseNotes = notes;
    }
  }
  if (has('updatePolicy')) {
    if (!POLICIES.includes(src.updatePolicy)) err('updatePolicy', 'Policy must be OPTIONAL, RECOMMENDED or CRITICAL (mandatory comes from the minimum supported version).');
    else values.updatePolicy = src.updatePolicy;
  }
  if (has('rolloutPercentage')) {
    const v = Number(src.rolloutPercentage);
    if (!ROLLOUT_STEPS.includes(v)) err('rolloutPercentage', 'Rollout must be 10, 25, 50, 75 or 100 %.'); else values.rolloutPercentage = v;
  }
  if (has('playStoreUrl')) {
    const v = validatePlayStoreUrl(src.playStoreUrl, pkg);
    if (!v) err('playStoreUrl', `Use the official listing: ${canonicalPlayStoreUrl(pkg)}`); else values.playStoreUrl = v;
  }
  if (has('reminderCooldownHours')) {
    const v = Number(src.reminderCooldownHours);
    if (!Number.isInteger(v) || v < 1 || v > 720) err('reminderCooldownHours', 'Reminder cooldown: 1–720 hours.'); else values.reminderCooldownHours = v;
  }
  if (has('maxReminders')) {
    const v = Number(src.maxReminders);
    if (!Number.isInteger(v) || v < 1 || v > 20) err('maxReminders', 'Maximum reminders: 1–20.'); else values.maxReminders = v;
  }
  if (has('allowPostponement')) {
    if (typeof src.allowPostponement !== 'boolean') err('allowPostponement', 'allowPostponement must be true or false.'); else values.allowPostponement = src.allowPostponement;
  }
  if (has('scheduleTimeZone')) {
    if (src.scheduleTimeZone === null || src.scheduleTimeZone === '') values.scheduleTimeZone = null;
    else if (!isTimeZone(src.scheduleTimeZone)) err('scheduleTimeZone', 'Unknown time zone.'); else values.scheduleTimeZone = src.scheduleTimeZone;
  }
  if (has('scheduledAt')) {
    if (src.scheduledAt === null || src.scheduledAt === '') values.scheduledAt = null;
    else {
      const d = new Date(src.scheduledAt);
      if (Number.isNaN(d.getTime())) err('scheduledAt', 'Scheduled time is not a valid date.'); else values.scheduledAt = d;
    }
  }

  // Cross-field: the minimum supported version can never be above this release.
  const code = values.versionCode ?? (existing && existing.versionCode);
  const min = values.minimumSupportedVersionCode ?? (existing && existing.minimumSupportedVersionCode);
  if (code != null && min != null && min > code) {
    err('minimumSupportedVersionCode', 'Minimum supported version code cannot be above this release’s version code.');
  }
  return errors.length ? { errors } : { values };
}

module.exports = {
  MAX_VERSION_CODE, POLICIES, ROLLOUT_STEPS, CHECK_AGAIN_SECONDS, EDITABLE_ALWAYS, EDITABLE_BEFORE_PUBLISH,
  androidPackage, canonicalPlayStoreUrl, parseVersionCode, parseVersionName, validatePlayStoreUrl,
  rolloutBucket, inRollout, decideUpdate, clientResponse, readReleaseInput, isTimeZone,
};
