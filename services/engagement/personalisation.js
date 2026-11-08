// services/engagement/personalisation.js
// -----------------------------------------------------------------------------
// PERSONALISATION ENGINE — builds the per-user context the opportunity sources and the
// selection engine read. Only legitimate, existing Humrah signals are used:
//
//   interests      questionnaire.humrahRoomInterests / hobbies / interests /
//                  conversationInterests (what the user chose in onboarding)
//   sports         sportsDiscoveryService.hasSportsInterest — the exact Sports rule
//   location       the user's own last app-reported location, ONLY when it is real
//                  (not the [0,0] default), fresh (ENGAGEMENT_LOCATION_MAX_AGE_DAYS) and
//                  the user has not switched off "Nearby activities". It stays in memory
//                  for database queries; it is never stored, logged, rendered or sent.
//   radius         ENGAGEMENT_RADIUS_KM (default 10 km — the Sports and Questions radius;
//                  there is no per-user radius setting in Humrah)
//   blocks         both directions (sportsPlanService.blockedCounterparts semantics)
//   history        this user's own engagement notifications (last category, opens)
//
// Never used: private chat messages, gender, age, relationship or mood fields, other
// users' profiles, or anything inferred.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const User = require('../../models/User');
const EngagementNotification = require('../../models/EngagementNotification');
const { canonicalizeTopics } = require('../../utils/roomTopicConfig');
const { hasSportsInterest } = require('../sportsDiscoveryService')._internal;

const { ObjectId } = mongoose.Types;

function validPoint(user) {
  const ll = user && user.liveLocation;
  if (!ll) return null;
  let lng = Number(ll.lng);
  let lat = Number(ll.lat);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const c = Array.isArray(ll.coordinates) ? ll.coordinates : [];
    lng = Number(c[0]); lat = Number(c[1]);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;                 // schema default = "no location"
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

/** The location the sources may use, or null with a reason. */
function locationFor(user, now, cfg) {
  if (user && user.notifications && user.notifications.nearbyActivities === false) return { point: null, reason: 'NEARBY_DISABLED' };
  const point = validPoint(user);
  if (!point) return { point: null, reason: 'NO_LOCATION' };
  const at = user.last_location_updated_at ? new Date(user.last_location_updated_at).getTime() : NaN;
  if (!Number.isFinite(at) || now - at > cfg.locationMaxAgeMs) return { point: null, reason: 'LOCATION_STALE' };
  return { point, reason: null };
}

const lowerList = list => (Array.isArray(list) ? list : []).filter(s => typeof s === 'string').map(s => s.trim().toLowerCase()).filter(Boolean);

async function blockedIds(user) {
  const mine = (user.blockedUsers || []).filter(id => mongoose.isValidObjectId(id)).map(id => new ObjectId(String(id)));
  const theirs = await User.find({ blockedUsers: user._id }).select('_id').lean();
  const all = [...mine, ...theirs.map(t => t._id)];
  return { list: all, set: new Set(all.map(String)) };
}

async function historyFor(userId) {
  const rows = await EngagementNotification.find({ userId })
    .sort({ createdAt: -1 }).limit(20)
    .select('category status openedAt createdAt').lean();
  const lastDelivered = rows.find(r => r.status === 'SENT');
  return {
    lastCategory: lastDelivered ? lastDelivered.category : null,
    openedCategories: new Set(rows.filter(r => r.openedAt).map(r => r.category)),
  };
}

/**
 * @param {object} user  lean User with eligibility.USER_FIELDS
 * @param {object} opts  { now, cfg, shared } — shared is a per-tick memo the sources may use
 */
async function buildContext(user, { now, cfg, shared }) {
  const q = user.questionnaire || {};
  const loc = locationFor(user, now, cfg);
  const [blocked, history] = await Promise.all([blockedIds(user), historyFor(user._id)]);
  return {
    user,
    userId: user._id,
    now,
    cfg,
    shared: shared || {},
    point: loc.point,
    locationReason: loc.reason,
    radiusKm: cfg.radiusKm,
    roomTopics: canonicalizeTopics(q.humrahRoomInterests),
    sportsInterest: hasSportsInterest(q),
    interestWords: new Set([...lowerList(q.hobbies), ...lowerList(q.interests), ...lowerList(q.conversationInterests), ...lowerList(q.humrahRoomInterests)]),
    blocked,
    history,
  };
}

module.exports = { buildContext, locationFor, _internal: { validPoint, blockedIds, historyFor } };
