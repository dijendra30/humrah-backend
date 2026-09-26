// services/sportsPlanService.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 1A business logic: create, get, nearby, join, leave,
// cancel. No notifications, no chat, no ratings (later phases).
//
// Every function takes the authenticated user (req.user, set by middleware/auth.js)
// and returns one of:
//   { success: true,  status, plan | plans, ... }
//   { success: false, status, code, message, ... }
// The route turns that into HTTP. Nothing here reads req or writes res, so it can be
// exercised directly.
//
// Every state change is ONE guarded findOneAndUpdate. Neither reference system does
// this for join — both Movie and Gaming read the plan, check the count in JavaScript,
// then write, so two simultaneous joins can both pass the check and overfill it.
// Here the capacity check and the write are the same atomic operation.
// -----------------------------------------------------------------------------
'use strict';

const mongoose   = require('mongoose');
const SportsPlan = require('../models/SportsPlan');
const User       = require('../models/User');
const { resolveSportImageUrl } = require('../utils/sportsImageConfig');
// Phase 2A: every plan change is followed by its session (services/sportsSessionService.js).
const sessions   = require('./sportsSessionService');

const { ObjectId } = mongoose.Types;

// ── Allowed values ─────────────────────────────────────────────────────────────
// Validated here, not as schema enums, so this list can grow without a schema
// deploy and no existing document can ever fail validation because of it.
const SPORT_TYPES = Object.freeze([
  'badminton', 'football', 'cricket', 'basketball', 'tennis',
  'table_tennis', 'running', 'cycling', 'gym', 'yoga',
]);
const SKILL_LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced', 'any']);
// Phase 1B: the app no longer asks for a skill level. A request that omits it gets
// 'any'; one that sends a value is still held to the allow-list, so existing
// clients and existing documents behave exactly as before.
const DEFAULT_SKILL_LEVEL = 'any';

const SPORT_SET = new Set(SPORT_TYPES);
const SKILL_SET = new Set(SKILL_LEVELS);

// ── Limits ─────────────────────────────────────────────────────────────────────
const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

// Players per plan, INCLUDING the creator. At least 2 for every sport; the most is
// one game of that sport. Checked on create only, so plans that already exist keep
// the limit they were created with.
const PLAYER_LIMIT_MIN = 2;
const PLAYER_LIMIT_MAX_BY_SPORT = Object.freeze({
  badminton:    4,    // doubles
  football:     10,   // 5-a-side
  cricket:      12,   // box cricket, 6 a side
  basketball:   10,   // 5-on-5
  tennis:       4,    // doubles
  table_tennis: 4,    // doubles
  running:      6,    // a small group run
  cycling:      4,    // a small group ride
  gym:          4,    // gym buddies
  yoga:         6,    // a small group session
});
// The largest of the above.
const PLAYER_LIMIT_MAX = Math.max(...Object.values(PLAYER_LIMIT_MAX_BY_SPORT));

// Same as GamingSession.optionalMessage, the closest existing plan note.
const NOTE_MAX = 120;

// TEMPORARY (Phase 1A). No product limit has been set yet — Phase 0 decision #4.
// Gaming allows 3 hours ahead and Surprise Activity today-or-tomorrow; both are too
// short for sport, which is usually planned days ahead. 7 days is the smallest
// window that lets a Monday plan cover the weekend.
const MAX_LEAD_MS = 7 * DAY;

// TEMPORARY (Phase 1A). No existing product defines a maximum session length, and
// leaving it unbounded would let one "plan" occupy the feed for weeks or stand in
// for the recurring plans this phase explicitly excludes. 12 hours covers a
// full-day cricket match.
const MAX_DURATION_MS = 12 * HOUR;

// Chat stays open 3 hours after the plan ends. Movie (showTime + 3h) and Gaming
// (startTime + 3h) both use 3 hours; Sports anchors on endTime because it has one.
// Phase 4 owns the real chat lifetime.
const CHAT_GRACE_MS = 3 * HOUR;

// Nearby: 20 km default (Movie's MAX_RADIUS_M, Surprise Activity's /nearby), 50 km
// ceiling (Gaming's /sessions). A larger request is clamped, never honoured.
const DEFAULT_RADIUS_KM = 20;
const MAX_RADIUS_KM     = 50;
const DEFAULT_RESULTS   = 20;
const MAX_RESULTS       = 50;

const VENUE_NAME_MIN = 2;
const VENUE_NAME_MAX = 120;
const VENUE_ADDRESS_MAX = 200;
const PLACE_ID_MAX = 200;
const CITY_MAX = 80;

// Public profile fields only — the same set Surprise Activity's /nearby exposes for
// a creator. No phone, email, location, tokens or questionnaire.
const PUBLIC_USER_FIELDS = 'firstName profilePhoto verified photoVerificationStatus';

// ── Small helpers ──────────────────────────────────────────────────────────────
const fail = (status, code, message, extra = {}) =>
  ({ success: false, status, code, message, ...extra });

const notFound = () => fail(404, 'PLAN_NOT_FOUND', 'This plan does not exist or is no longer available.');

const isValidId = id => typeof id === 'string' && mongoose.isValidObjectId(id) && /^[a-f0-9]{24}$/i.test(id);

const includesId = (list, id) => (list || []).some(x => String(x) === String(id));

/**
 * Coerces a value to a finite number, refusing anything that is not already a
 * number or a numeric string. Booleans, arrays and objects (including query-string
 * injection like `?lat[$gt]=0`) all become NaN.
 */
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** Lower-cased, trimmed token for allow-list comparison. Non-strings become ''. */
const token = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * Real coordinates only. (0, 0) is rejected because the app uses it as its
 * "no GPS fix yet" sentinel — it is not a real venue in the Gulf of Guinea.
 */
function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);
}

function parseDate(v) {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Same rule Surprise Activity's /create uses, and a superset of Movie Hangout's
 * (which requires photoVerificationStatus alone). Both existing physical-meetup
 * features require verification to create and to join; Sports does the same.
 */
const isVerified = user => user?.verified === true || user?.photoVerificationStatus === 'approved';

const round = (n, dp) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);

function publicUser(u) {
  if (!u) return null;
  return {
    id:           String(u._id),
    firstName:    u.firstName || 'Someone',
    profilePhoto: u.profilePhoto || null,
    verified:     isVerified(u),
  };
}

/**
 * True when either side has blocked the other. Honours both directions, as the
 * existing companion request flow does (routes/companions.js).
 */
async function isBlockedPair(user, otherId) {
  if (!otherId || String(otherId) === String(user._id)) return false;
  if (includesId(user.blockedUsers, otherId)) return true;
  return !!(await User.exists({ _id: otherId, blockedUsers: user._id }));
}

/** Everyone the user has blocked, plus everyone who has blocked the user. */
async function blockedCounterparts(user) {
  const mine = (user.blockedUsers || [])
    .filter(id => mongoose.isValidObjectId(id))
    .map(id => new ObjectId(String(id)));
  const theirs = await User.find({ blockedUsers: user._id }).select('_id').lean();
  return [...mine, ...theirs.map(t => t._id)];
}

async function loadUsers(ids) {
  if (!ids || ids.length === 0) return [];
  return User.find({ _id: { $in: ids } }).select(PUBLIC_USER_FIELDS).lean();
}

// ── Response shape ─────────────────────────────────────────────────────────────
/**
 * The only way a plan leaves this service. Fields are mapped explicitly so no
 * internal field (__v, kickedPlayers, chatExpiresAt, raw ObjectIds) leaks.
 *
 * Derived, never stored:
 *   playerCount / spotsLeft / isFull  — from playersJoined
 *   cardStatus 'expired'              — an 'open' plan whose start time has passed.
 *                                       Phase 1A has no expiry sweep, so this is
 *                                       computed at read time.
 *
 * Venue coordinates are rounded to 4 dp (~11 m) for anyone who has not joined, and
 * exact for participants, who need them to navigate there. The participant list is
 * returned to participants only.
 */
function formatPlan(plan, viewerId, { creator = null, participants = null, distanceM = null } = {}) {
  const now      = Date.now();
  const viewer   = String(viewerId);
  const players  = (plan.playersJoined || []).map(String);
  const count    = players.length;
  const isFull   = count >= plan.playerLimit;
  const started  = new Date(plan.startTime).getTime() <= now;

  const isCreator     = String(plan.creatorId) === viewer;
  const isParticipant = players.includes(viewer);
  const isKicked      = includesId(plan.kickedPlayers, viewer);

  const cardStatus = plan.cardStatus === 'open' && started ? 'expired' : plan.cardStatus;

  const v  = plan.venue || {};
  const dp = isParticipant ? 7 : 4;

  const out = {
    id:              String(plan._id),
    sportType:       plan.sportType,
    // The sport's artwork, from utils/sportsImageConfig.js. Looked up here on every
    // response — never stored on the plan, never taken from a request. null = none.
    sportImageUrl:   resolveSportImageUrl(plan.sportType),
    customSportName: plan.customSportName || null,
    skillLevel:      plan.skillLevel,
    note:            plan.note || null,
    startTime:       new Date(plan.startTime).toISOString(),
    endTime:         new Date(plan.endTime).toISOString(),
    venue: {
      name:            v.name || null,
      address:         v.address || null,
      provider:        v.provider || null,
      providerPlaceId: v.providerPlaceId || null,
      latitude:        round(v.latitude, dp),
      longitude:       round(v.longitude, dp),
    },
    city:        plan.city || null,
    playerLimit: plan.playerLimit,
    playerCount: count,
    spotsLeft:   Math.max(0, plan.playerLimit - count),
    isFull,
    cardStatus,
    chatStatus:  plan.chatStatus,
    // From the viewer's point of view: can THIS user join right now?
    isJoinable:  cardStatus === 'open' && !isFull && !isParticipant && !isKicked,
    creator:     publicUser(creator),
    viewer:      { isCreator, isParticipant, isKicked },
    createdAt:   plan.createdAt ? new Date(plan.createdAt).toISOString() : null,
    updatedAt:   plan.updatedAt ? new Date(plan.updatedAt).toISOString() : null,
  };

  if (isParticipant && participants) {
    // Keep the join order, creator first.
    const byId = new Map(participants.map(p => [String(p._id), p]));
    out.participants = players.map(id => publicUser(byId.get(id))).filter(Boolean);
  }
  if (distanceM != null) out.distanceKm = round(distanceM / 1000, 1);

  return out;
}

/**
 * @param viewer the caller's user document (or, from older call sites, their id).
 *   With the document, a member is not shown anyone they have blocked or who has
 *   blocked them in the participant list (Phase 2A); the player count is unchanged.
 */
async function formatWithPeople(plan, viewer) {
  const viewerId = viewer && viewer._id ? viewer._id : viewer;
  const viewerIsMember = includesId(plan.playersJoined, viewerId);
  const ids = viewerIsMember ? plan.playersJoined : [plan.creatorId];
  let people = await loadUsers(ids);
  const creator = people.find(p => String(p._id) === String(plan.creatorId)) || null;
  if (viewerIsMember && viewer && viewer._id) {
    const hidden = new Set((await blockedCounterparts(viewer)).map(String));
    if (hidden.size) people = people.filter(p => !hidden.has(String(p._id)));
  }
  return formatPlan(plan, viewerId, { creator, participants: viewerIsMember ? people : null });
}

/** Adds the session id to a plan shown to one of its members (Phase 2A). */
function withSession(formatted, session) {
  if (session && formatted && formatted.viewer && formatted.viewer.isParticipant) {
    formatted.sessionId = String(session._id || session);
  }
  return formatted;
}

/** The session fields a route needs for its socket events. */
const sessionRef = session => (session ? { id: String(session._id), status: session.status } : null);

// ── Validation ─────────────────────────────────────────────────────────────────
function validateVenue(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: fail(400, 'INVALID_VENUE', 'A venue is required.') };
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < VENUE_NAME_MIN || name.length > VENUE_NAME_MAX) {
    return { error: fail(400, 'INVALID_VENUE', `Venue name must be ${VENUE_NAME_MIN}–${VENUE_NAME_MAX} characters.`) };
  }

  let address = null;
  if (input.address != null && input.address !== '') {
    if (typeof input.address !== 'string' || input.address.trim().length > VENUE_ADDRESS_MAX) {
      return { error: fail(400, 'INVALID_VENUE', `Venue address must be at most ${VENUE_ADDRESS_MAX} characters.`) };
    }
    address = input.address.trim() || null;
  }

  const lat = toNumber(input.latitude);
  const lng = toNumber(input.longitude);
  if (!validCoords(lat, lng)) {
    return { error: fail(400, 'INVALID_LOCATION', 'Venue latitude and longitude must be valid coordinates.') };
  }

  const provider = input.provider == null || input.provider === '' ? 'MANUAL' : input.provider;
  if (provider !== 'MANUAL' && provider !== 'GOOGLE_PLACES') {
    return { error: fail(400, 'INVALID_VENUE', 'Venue provider must be MANUAL or GOOGLE_PLACES.') };
  }

  let providerPlaceId = null;
  if (provider === 'GOOGLE_PLACES' && input.providerPlaceId != null && input.providerPlaceId !== '') {
    if (typeof input.providerPlaceId !== 'string' || input.providerPlaceId.length > PLACE_ID_MAX) {
      return { error: fail(400, 'INVALID_VENUE', 'Invalid venue place id.') };
    }
    providerPlaceId = input.providerPlaceId.trim();
  }

  return {
    lat,
    lng,
    venue: {
      provider,
      providerPlaceId,
      name,
      latitude:  lat,
      longitude: lng,
      // Not accepted from the client in Phase 1A: third-party rating, photo and
      // opening-hours data would be stale the moment it was stored.
      photoReference: null,
      rating:         null,
      address,
      openingStatus:  null,
    },
  };
}

function resolveCity(user, raw) {
  if (raw != null && raw !== '') {
    if (typeof raw !== 'string' || raw.trim().length > CITY_MAX) return { error: true };
    return { city: raw.trim().toLowerCase() };
  }
  // Fallback, as Gaming does: the creator's own city. A label only — discovery is geo.
  const fallback = user?.liveLocation?.city || user?.questionnaire?.city || '';
  return { city: String(fallback).trim().toLowerCase().slice(0, CITY_MAX) };
}

// ── CREATE ─────────────────────────────────────────────────────────────────────
async function createPlan(user, body = {}) {
  if (!body || typeof body !== 'object') body = {};

  if (!isVerified(user)) {
    return fail(403, 'VERIFICATION_REQUIRED',
      'Only verified users can create a Sports plan. Complete your profile verification to continue.');
  }

  const sportType = token(body.sportType);
  if (!SPORT_SET.has(sportType)) {
    return fail(400, 'INVALID_SPORT_TYPE', 'Choose one of the supported sports.', { allowed: SPORT_TYPES });
  }
  // The product has no custom-sport option yet, so the API does not accept one.
  if (body.customSportName != null && body.customSportName !== '') {
    return fail(400, 'INVALID_SPORT_TYPE', 'Custom sports are not supported yet.');
  }

  const skillLevel = body.skillLevel == null || body.skillLevel === ''
    ? DEFAULT_SKILL_LEVEL
    : token(body.skillLevel);
  if (!SKILL_SET.has(skillLevel)) {
    return fail(400, 'INVALID_SKILL_LEVEL', 'Choose a supported skill level.', { allowed: SKILL_LEVELS });
  }

  const start = parseDate(body.startTime);
  const end   = parseDate(body.endTime);
  if (!start || !end) {
    return fail(400, 'INVALID_TIME', 'startTime and endTime must be valid ISO-8601 dates.');
  }
  const now = Date.now();
  if (start.getTime() <= now) {
    return fail(400, 'INVALID_TIME', 'The start time must be in the future.');
  }
  if (start.getTime() - now > MAX_LEAD_MS) {
    return fail(400, 'INVALID_TIME', `Plans can be created up to ${MAX_LEAD_MS / DAY} days ahead.`);
  }
  if (end.getTime() <= start.getTime()) {
    return fail(400, 'INVALID_TIME', 'The end time must be after the start time.');
  }
  if (end.getTime() - start.getTime() > MAX_DURATION_MS) {
    return fail(400, 'INVALID_TIME', `A plan can last at most ${MAX_DURATION_MS / HOUR} hours.`);
  }

  const playerLimit = toNumber(body.playerLimit);
  const playerMax = PLAYER_LIMIT_MAX_BY_SPORT[sportType] || PLAYER_LIMIT_MAX;
  if (!Number.isInteger(playerLimit) || playerLimit < PLAYER_LIMIT_MIN || playerLimit > playerMax) {
    return fail(400, 'INVALID_PLAYER_LIMIT',
      `For ${sportType.replace(/_/g, ' ')}, choose ${PLAYER_LIMIT_MIN} to ${playerMax} players, including you.`,
      { min: PLAYER_LIMIT_MIN, max: playerMax });
  }

  let note = null;
  if (body.note != null && body.note !== '') {
    if (typeof body.note !== 'string') {
      return fail(400, 'INVALID_NOTE', 'The note must be text.');
    }
    const trimmed = body.note.trim();
    if (trimmed.length > NOTE_MAX) {
      return fail(400, 'INVALID_NOTE', `The note can be at most ${NOTE_MAX} characters.`);
    }
    note = trimmed || null;
  }

  const venueCheck = validateVenue(body.venue);
  if (venueCheck.error) return venueCheck.error;

  const cityCheck = resolveCity(user, body.city);
  if (cityCheck.error) return fail(400, 'INVALID_CITY', `City must be at most ${CITY_MAX} characters.`);

  // One active plan per creator — Gaming's anti-spam rule, and it also means nobody
  // can be hosting two plans at once. "Active" = open and not yet ended.
  const active = await SportsPlan.findOne({
    creatorId:  user._id,
    cardStatus: 'open',
    endTime:    { $gt: new Date() },
  }).select('_id').lean();
  if (active) {
    return fail(409, 'ACTIVE_PLAN_EXISTS',
      'You already have an active Sports plan. Cancel it or wait until it ends.',
      { activePlanId: String(active._id) });
  }

  const plan = await SportsPlan.create({
    creatorId:       user._id,
    sportType,
    customSportName: null,
    startTime:       start,
    endTime:         end,
    venue:           venueCheck.venue,
    // The VENUE's point. Never user.liveLocation — the creator may not be there.
    location:        { type: 'Point', coordinates: [venueCheck.lng, venueCheck.lat] },
    city:            cityCheck.city,
    playerLimit,
    playersJoined:   [user._id],          // the creator is participant #1
    skillLevel,
    note,
    cardStatus:      'open',
    chatStatus:      'open',
    chatExpiresAt:   new Date(end.getTime() + CHAT_GRACE_MS),
    kickedPlayers:   [],
  });

  const out = plan.toObject();
  // Phase 2A: the plan's session, with the host as its first member.
  const session = await sessions.onPlanCreated(out);
  return {
    success: true,
    status:  201,
    plan:    withSession(formatPlan(out, user._id, { creator: user, participants: [user] }), session),
    session: sessionRef(session),
  };
}

// ── GET ────────────────────────────────────────────────────────────────────────
async function getPlan(user, planId) {
  if (!isValidId(planId)) return notFound();

  const plan = await SportsPlan.findById(planId).lean();
  if (!plan) return notFound();

  // A blocked pair cannot see each other's plans. 404, not 403, so a block is not
  // revealed.
  if (await isBlockedPair(user, plan.creatorId)) return notFound();

  const formatted = await formatWithPeople(plan, user);
  // A plan whose creator's account no longer exists is treated as gone.
  if (!formatted.creator) return notFound();
  if (formatted.viewer.isParticipant) {
    // Members get the session id; a plan from before Phase 2A gets its session here.
    withSession(formatted, await sessions.sessionIdForMember(plan));
  }

  return { success: true, status: 200, plan: formatted };
}

// ── NEARBY ─────────────────────────────────────────────────────────────────────
async function getNearbyPlans(user, query = {}) {
  const lat = toNumber(query.lat ?? query.latitude);
  const lng = toNumber(query.lng ?? query.longitude);
  if (!validCoords(lat, lng)) {
    return fail(400, 'INVALID_LOCATION', 'lat and lng are required and must be valid coordinates.');
  }

  let radiusKm = DEFAULT_RADIUS_KM;
  if (query.radiusKm != null && query.radiusKm !== '') {
    const r = toNumber(query.radiusKm);
    if (!Number.isFinite(r) || r <= 0) {
      return fail(400, 'INVALID_RADIUS', 'radiusKm must be a positive number.');
    }
    radiusKm = Math.min(r, MAX_RADIUS_KM);
  }

  let limit = DEFAULT_RESULTS;
  if (query.limit != null && query.limit !== '') {
    const l = toNumber(query.limit);
    if (!Number.isInteger(l) || l < 1) {
      return fail(400, 'INVALID_LIMIT', 'limit must be a positive whole number.');
    }
    limit = Math.min(l, MAX_RESULTS);
  }

  const now = new Date();
  // Only plans that have not started: an open card disappears at its start time.
  const startFilter = { $gt: now };

  if (query.from != null && query.from !== '') {
    const from = parseDate(query.from);
    if (!from) return fail(400, 'INVALID_TIME', 'from must be a valid ISO-8601 date.');
    if (from > now) startFilter.$gte = from;
  }
  if (query.to != null && query.to !== '') {
    const to = parseDate(query.to);
    if (!to) return fail(400, 'INVALID_TIME', 'to must be a valid ISO-8601 date.');
    if (startFilter.$gte && to < startFilter.$gte) {
      return fail(400, 'INVALID_TIME', 'to must not be before from.');
    }
    startFilter.$lte = to;
  }

  const match = {
    cardStatus:    'open',
    startTime:     startFilter,
    kickedPlayers: { $ne: user._id },
  };

  if (query.sportType != null && query.sportType !== '') {
    const sport = token(query.sportType);
    if (!SPORT_SET.has(sport)) {
      return fail(400, 'INVALID_SPORT_TYPE', 'Unknown sportType.', { allowed: SPORT_TYPES });
    }
    match.sportType = sport;
  }

  const exclude = await blockedCounterparts(user);
  if (exclude.length) match.creatorId = { $nin: exclude };

  const rows = await SportsPlan.aggregate([
    {
      $geoNear: {
        near:          { type: 'Point', coordinates: [lng, lat] },
        distanceField: 'distanceM',
        maxDistance:   radiusKm * 1000,
        spherical:     true,
        key:           'location',
        query:         match,
      },
    },
    { $limit: limit },
  ]);

  const creators = await loadUsers([...new Set(rows.map(r => String(r.creatorId)))]);
  const byId = new Map(creators.map(c => [String(c._id), c]));

  const plans = rows
    // A plan whose creator's account no longer exists is not shown.
    .filter(r => byId.has(String(r.creatorId)))
    .map(r => formatPlan(r, user._id, { creator: byId.get(String(r.creatorId)), distanceM: r.distanceM }));

  return { success: true, status: 200, plans, count: plans.length, radiusKm };
}

// ── JOIN ───────────────────────────────────────────────────────────────────────
async function joinPlan(user, planId) {
  if (!isValidId(planId)) return notFound();

  if (!isVerified(user)) {
    return fail(403, 'VERIFICATION_REQUIRED',
      'Only verified users can join a Sports plan. Complete your profile verification to continue.');
  }

  const pid = new ObjectId(planId);
  const uid = user._id;

  // Blocks are checked first. They are not what keeps the plan from overfilling —
  // the guarded update below does that — and blocking does not race with joining
  // in any way that matters.
  const head = await SportsPlan.findById(pid).select('creatorId').lean();
  if (!head) return notFound();
  if (await isBlockedPair(user, head.creatorId)) return notFound();

  const now = new Date();

  // ONE atomic operation. MongoDB evaluates the filter and applies the update to a
  // single document as one step, so two simultaneous joins for the last spot
  // cannot both match: the second is evaluated against the array the first one
  // already grew, fails the $expr, and gets null.
  const updated = await SportsPlan.findOneAndUpdate(
    {
      _id:           pid,
      cardStatus:    'open',
      startTime:     { $gt: now },        // a plan that has started is closed to joins
      playersJoined: { $ne: uid },        // no duplicate join
      kickedPlayers: { $ne: uid },        // a removed player cannot come back
      $expr:         { $lt: [{ $size: '$playersJoined' }, '$playerLimit'] },
    },
    { $addToSet: { playersJoined: uid } },
    { new: true }
  ).lean();

  if (updated) {
    const session = await sessions.onPlayerJoined(updated, uid);
    return {
      success: true,
      status:  200,
      joined:  true,
      plan:    withSession(await formatWithPeople(updated, user), session),
      session: sessionRef(session),
    };
  }

  // The update matched nothing. Re-read once to say WHY — this read cannot change
  // the outcome, only explain it.
  const plan = await SportsPlan.findById(pid).lean();
  if (!plan) return notFound();
  if (includesId(plan.kickedPlayers, uid)) {
    return fail(403, 'USER_KICKED', 'You were removed from this plan and cannot rejoin.');
  }
  if (includesId(plan.playersJoined, uid)) {
    return fail(409, 'ALREADY_JOINED', 'You are already in this plan.');
  }
  if (plan.cardStatus !== 'open' || new Date(plan.startTime) <= now) {
    return fail(410, 'PLAN_CLOSED', 'This plan is no longer accepting players.');
  }
  if ((plan.playersJoined || []).length >= plan.playerLimit) {
    return fail(409, 'PLAN_FULL', 'This plan is full.');
  }
  // The plan changed between the two reads. Rare; safe to retry.
  return fail(409, 'JOIN_CONFLICT', 'Could not join right now. Please try again.');
}

// ── LEAVE ──────────────────────────────────────────────────────────────────────
async function leavePlan(user, planId) {
  if (!isValidId(planId)) return notFound();

  const pid = new ObjectId(planId);
  const uid = user._id;
  const now = new Date();

  // The creator is excluded in the filter itself, so a host can never be pulled
  // out of their own plan by this route — they cancel instead. Membership is only
  // editable while the plan has not ended; after that it is history.
  const updated = await SportsPlan.findOneAndUpdate(
    {
      _id:           pid,
      creatorId:     { $ne: uid },
      playersJoined: uid,
      cardStatus:    'open',
      endTime:       { $gt: now },
    },
    { $pull: { playersJoined: uid } },
    { new: true }
  ).lean();

  if (updated) {
    const session = await sessions.onPlayerLeft(updated, uid);
    return { success: true, status: 200, left: true, plan: await formatWithPeople(updated, user), session: sessionRef(session) };
  }

  const plan = await SportsPlan.findById(pid).lean();
  if (!plan) return notFound();
  if (String(plan.creatorId) === String(uid)) {
    return fail(400, 'CREATOR_CANNOT_LEAVE', 'You are hosting this plan. Cancel it instead of leaving.');
  }
  if (!includesId(plan.playersJoined, uid)) {
    // Also the answer to a repeated leave: nothing changes, nothing breaks.
    return fail(400, 'NOT_A_PARTICIPANT', 'You are not in this plan.');
  }
  return fail(410, 'PLAN_CLOSED', 'This plan has already ended or been cancelled.');
}

// ── CANCEL ─────────────────────────────────────────────────────────────────────
async function cancelPlan(user, planId) {
  if (!isValidId(planId)) return notFound();

  const pid = new ObjectId(planId);
  const uid = user._id;
  const now = new Date();

  // Creator-only, open-only, not-yet-ended — all in the filter. The document and
  // its participant list are kept; only the two statuses change.
  const updated = await SportsPlan.findOneAndUpdate(
    { _id: pid, creatorId: uid, cardStatus: 'open', endTime: { $gt: now } },
    { $set: { cardStatus: 'cancelled', chatStatus: 'closed', cancelledAt: now } },
    { new: true }
  ).lean();

  if (updated) {
    const session = await sessions.onPlanCancelled(updated);
    return {
      success:   true,
      status:    200,
      cancelled: true,
      plan:      withSession(await formatWithPeople(updated, user), session),
      session:   sessionRef(session),
    };
  }

  const plan = await SportsPlan.findById(pid).lean();
  if (!plan) return notFound();
  if (String(plan.creatorId) !== String(uid)) {
    return fail(403, 'NOT_PLAN_CREATOR', 'Only the host can cancel this plan.');
  }
  if (plan.cardStatus === 'cancelled') {
    return fail(409, 'ALREADY_CANCELLED', 'This plan is already cancelled.');
  }
  return fail(410, 'PLAN_CLOSED', 'This plan has already ended.');
}

module.exports = {
  createPlan,
  getPlan,
  getNearbyPlans,
  joinPlan,
  leavePlan,
  cancelPlan,
  // For services/sportsSessionService.js, which shows plans the same way.
  _internal: { formatPlan, formatWithPeople, isBlockedPair, blockedCounterparts },
  // Exposed for tests and for the Phase 1A report.
  constants: Object.freeze({
    SPORT_TYPES, SKILL_LEVELS, DEFAULT_SKILL_LEVEL,
    PLAYER_LIMIT_MIN, PLAYER_LIMIT_MAX, PLAYER_LIMIT_MAX_BY_SPORT, NOTE_MAX,
    MAX_LEAD_MS, MAX_DURATION_MS, CHAT_GRACE_MS,
    DEFAULT_RADIUS_KM, MAX_RADIUS_KM, DEFAULT_RESULTS, MAX_RESULTS,
  }),
};
