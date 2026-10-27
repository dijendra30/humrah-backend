// services/companionProximityService.js
// -----------------------------------------------------------------------------
// The ONE canonical "is this Companion nearby for this user?" rule.
//
// WHY THIS FILE EXISTS: People Near You decided "nearby" inline, and for
// Companions it was wrong in three ways:
//   - a Companion with NO coordinates in the viewer's city was kept, with
//     distance 9999 (the "Task #6" fallback in home.controller.js);
//   - nothing checked how OLD either location was, so a Companion last seen
//     in Mumbai weeks ago stayed "near" anyone who had been in Mumbai;
//   - discovery appended every distant Companion to the end of the list, so a
//     short list put a Mumbai Companion (with a Meetup button) on a Delhi Home.
// And POST /api/bookings created a booking for any id at all.
//
// Every path that lists or books a Companion now reads this file, so there is
// exactly one definition. It introduces NO new radius: the default is the
// existing People Near You rule (2 km at night, 5 km by day — getRadiusKm() in
// home.controller.js), and the default freshness is the existing 24 h rule
// (User#hasRecentLocation, and the mood-matches location check).
//
// SERVER SETTINGS (both optional; unset = the existing rules above):
//   NEARBY_COMPANION_RADIUS_KM               fixed radius in km (0 < r <= 100)
//   NEARBY_COMPANION_LOCATION_MAX_AGE_HOURS  max location age (0 < h <= 168), default 24
//
// TRUST BOUNDARY: every location comes from the User documents. Nothing here
// accepts a coordinate, a radius or a distance from a request, and nothing
// here returns or logs a coordinate — callers get a distance or a reason code.
// -----------------------------------------------------------------------------
'use strict';

const User = require('../models/User');

const DEFAULT_MAX_AGE_HOURS = 24;

// Reason codes. NOT_NEARBY covers "too far", "location missing" and "location
// stale" on the caller's side of the booking API, so a response can't be used
// to probe where a Companion is.
const REASON = Object.freeze({
  OK:                          'OK',
  SELF:                        'SELF',
  NOT_COMPANION:               'NOT_COMPANION',
  COMPANION_UNAVAILABLE:       'COMPANION_UNAVAILABLE',
  BLOCKED:                     'BLOCKED',
  CALLER_LOCATION_UNAVAILABLE: 'CALLER_LOCATION_UNAVAILABLE',
  COMPANION_LOCATION_UNAVAILABLE: 'COMPANION_LOCATION_UNAVAILABLE',
  OUT_OF_RANGE:                'OUT_OF_RANGE',
});

// Fields a caller must select for the rule to work (both on the viewer and on
// each Companion candidate).
const LOCATION_FIELDS = 'liveLocation last_known_lat last_known_lng last_location_updated_at';
const COMPANION_FIELDS = `userType status hostActive profilePhoto blockedUsers ${LOCATION_FIELDS}`;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dL = (lat2 - lat1) * Math.PI / 180, dG = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dL / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _positiveEnv(name, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

/** The Companion radius in km: the server setting, else the existing day/night rule. */
function companionRadiusKm(now = new Date()) {
  const fixed = _positiveEnv('NEARBY_COMPANION_RADIUS_KM', 100);
  if (fixed !== null) return fixed;
  const h = now.getHours();
  return (h >= 21 || h < 6) ? 2 : 5;
}

/** How old a location may be, in ms. */
function maxLocationAgeMs() {
  return (_positiveEnv('NEARBY_COMPANION_LOCATION_MAX_AGE_HOURS', 168) ?? DEFAULT_MAX_AGE_HOURS) * 3600000;
}

function _validPair(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return !(lat === 0 && lng === 0); // the schema's default [0, 0] is "never set"
}

function _time(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * A user's usable location: the freshest stored source that has valid
 * coordinates AND its own timestamp inside the freshness window. null when
 * there is none — missing, invalid and stale all mean "not located".
 * Each source is judged by its own timestamp, so old liveLocation coordinates
 * can't borrow a newer legacy timestamp (or the other way round).
 */
function usableLocation(user, now = new Date()) {
  if (!user) return null;
  const ll = user.liveLocation || {};
  const sources = [
    { lat: ll.lat, lng: ll.lng, at: _time(ll.updatedAt) },
    { lat: user.last_known_lat, lng: user.last_known_lng, at: _time(user.last_location_updated_at) },
  ];
  const nowMs = now.getTime();
  const maxAge = maxLocationAgeMs();
  let best = null;
  for (const s of sources) {
    if (!_validPair(s.lat, s.lng) || s.at === null) continue;
    const age = nowMs - s.at;
    // A timestamp more than 5 minutes in the future is corrupt, not fresh.
    if (age > maxAge || age < -5 * 60000) continue;
    if (!best || s.at > best.at) best = s;
  }
  return best ? { lat: best.lat, lng: best.lng } : null;
}

/** An account that may be offered for a Meetup at all (ignores distance). */
function isEligibleCompanion(u) {
  return !!u
    && u.userType === 'COMPANION'
    && u.status === 'ACTIVE'
    && u.hostActive !== false          // "Hosting paused" hides them from bookings
    && !!u.profilePhoto;
}

function _ids(list) { return (list || []).map(String); }

/**
 * The rule. `viewer` and `companion` are User documents (lean or not) that
 * carry COMPANION_FIELDS / LOCATION_FIELDS + blockedUsers.
 * Returns { ok, reason, distanceKm } — distanceKm only when ok.
 */
function evaluate(viewer, companion, now = new Date()) {
  if (!viewer || !companion) return { ok: false, reason: REASON.COMPANION_UNAVAILABLE };
  if (String(viewer._id) === String(companion._id)) return { ok: false, reason: REASON.SELF };
  if (companion.userType !== 'COMPANION') return { ok: false, reason: REASON.NOT_COMPANION };
  if (!isEligibleCompanion(companion)) return { ok: false, reason: REASON.COMPANION_UNAVAILABLE };
  if (_ids(viewer.blockedUsers).includes(String(companion._id))
      || _ids(companion.blockedUsers).includes(String(viewer._id))) {
    return { ok: false, reason: REASON.BLOCKED };
  }
  const mine = usableLocation(viewer, now);
  if (!mine) return { ok: false, reason: REASON.CALLER_LOCATION_UNAVAILABLE };
  const theirs = usableLocation(companion, now);
  if (!theirs) return { ok: false, reason: REASON.COMPANION_LOCATION_UNAVAILABLE };
  const distanceKm = haversineKm(mine.lat, mine.lng, theirs.lat, theirs.lng);
  if (!(distanceKm <= companionRadiusKm(now))) return { ok: false, reason: REASON.OUT_OF_RANGE };
  return { ok: true, reason: REASON.OK, distanceKm };
}

/**
 * Server-side booking gate: loads both users from the database by id, so a
 * direct API call, a stale card or an old app can't assert proximity.
 * Returns { ok, status, code, message } for the route to send.
 */
async function checkCompanionBookable(viewerId, companionId, now = new Date()) {
  const [viewer, companion] = await Promise.all([
    User.findById(viewerId).select(`_id blockedUsers ${LOCATION_FIELDS}`).lean(),
    User.findById(companionId).select(`_id ${COMPANION_FIELDS}`).lean(),
  ]);
  if (!viewer) return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'User not found' };
  if (!companion) return { ok: false, status: 404, code: 'COMPANION_NOT_FOUND', message: 'Companion not found' };

  const r = evaluate(viewer, companion, now);
  switch (r.reason) {
    case REASON.OK:
      return { ok: true, status: 200, code: 'OK', distanceKm: r.distanceKm };
    case REASON.SELF:
      return { ok: false, status: 400, code: 'CANNOT_BOOK_SELF', message: "You can't book yourself." };
    case REASON.NOT_COMPANION:
    case REASON.COMPANION_UNAVAILABLE:
    case REASON.BLOCKED:
      // One answer for all three, so the response can't reveal a block.
      return { ok: false, status: 404, code: 'COMPANION_NOT_FOUND', message: 'This companion is not available.' };
    case REASON.CALLER_LOCATION_UNAVAILABLE:
      return { ok: false, status: 409, code: 'LOCATION_REQUIRED', message: 'Turn on location so we can check this companion is near you.' };
    default:
      // Too far, or the Companion's own location is missing / stale.
      return { ok: false, status: 403, code: 'COMPANION_NOT_NEARBY', message: 'This companion is not near you right now.' };
  }
}

module.exports = {
  REASON,
  LOCATION_FIELDS,
  COMPANION_FIELDS,
  DEFAULT_MAX_AGE_HOURS,
  haversineKm,
  companionRadiusKm,
  maxLocationAgeMs,
  usableLocation,
  isEligibleCompanion,
  evaluate,
  checkCompanionBookable,
};
