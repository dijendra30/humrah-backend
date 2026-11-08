// services/engagement/sources/sportsPlans.js
// SPORTS — a public, open Sports plan near the user, matching their sports interest.
//
// Same visibility rules as the Sports feed (sportsPlanService.getNearbyPlans): open,
// not started, not kicked; plus: not full, not already joined, nobody in it is blocked
// either way, and NOT a plan Sports discovery already pushed to this user (that feature
// owns "plan near you" announcements; this never repeats one).
// Requires a sports interest (hasSportsInterest) and verification (the join rule) —
// a user without them is not shown sports at all.
'use strict';

const mongoose = require('mongoose');
const SportsPlan = require('../../../models/SportsPlan');
const SportsDiscoveryDelivery = require('../../../models/SportsDiscoveryDelivery');
const User = require('../../../models/User');
const { SPORT_LABELS } = require('../variables');

const MIN = 60 * 1000;

function planUsable(plan, userId, blockedSet, now, minLeadMs) {
  if (!plan || plan.cardStatus !== 'open') return 'NOT_OPEN';
  if (new Date(plan.startTime).getTime() < now + minLeadMs) return 'STARTING_SOON';
  const players = (plan.playersJoined || []).map(String);
  if (players.includes(String(userId))) return 'ALREADY_JOINED';
  if ((plan.kickedPlayers || []).map(String).includes(String(userId))) return 'KICKED';
  if (players.length >= Number(plan.playerLimit || 0)) return 'FULL';
  if (blockedSet.has(String(plan.creatorId)) || players.some(p => blockedSet.has(p))) return 'BLOCKED';
  if (!SPORT_LABELS[plan.sportType]) return 'UNKNOWN_SPORT';
  return null;
}

async function collect(ctx) {
  if (!ctx.point || !ctx.sportsInterest) return [];
  const { cfg, now } = ctx;
  const plans = await SportsPlan.aggregate([
    { $geoNear: {
      near: { type: 'Point', coordinates: ctx.point },
      distanceField: 'd', maxDistance: ctx.radiusKm * 1000, spherical: true, key: 'location',
      query: {
        cardStatus: 'open',
        startTime: { $gte: new Date(now + cfg.sportsMinLeadMs), $lte: new Date(now + cfg.sportsMaxLeadMs) },
        kickedPlayers: { $ne: ctx.userId },
        playersJoined: { $ne: ctx.userId },
        creatorId: { $nin: [ctx.userId, ...ctx.blocked.list] },
      },
    } },
    { $limit: 20 },
    // Distance is used only for ordering above; it is dropped here and never leaves.
    { $project: { _id: 1, sportType: 1, playerLimit: 1, playersJoined: 1, kickedPlayers: 1, creatorId: 1, cardStatus: 1, startTime: 1 } },
  ]);
  if (plans.length === 0) return [];

  const announced = await SportsDiscoveryDelivery.find({ userId: ctx.userId, sportsPlanId: { $in: plans.map(p => p._id) } })
    .select('sportsPlanId').lean();
  const announcedSet = new Set(announced.map(a => String(a.sportsPlanId)));

  const out = [];
  for (const plan of plans) {
    if (announcedSet.has(String(plan._id))) continue;
    if (planUsable(plan, ctx.userId, ctx.blocked.set, now, cfg.sportsMinLeadMs)) continue;
    const label = SPORT_LABELS[plan.sportType];
    const namedSport = ctx.interestWords.has(plan.sportType) || ctx.interestWords.has(label);
    out.push({
      category: 'SPORTS',
      eventType: 'SPORTS_PLAN',
      eventRef: { kind: 'SportsPlan', id: String(plan._id) },
      eventKey: `SPORTS_PLAN:${plan._id}`,
      purpose: 'open_plan',
      vars: { sport_label: label, area_label: ctx.areaLabel },
      relevance: namedSport ? 1 : 0.75,
      relevantUntil: new Date(new Date(plan.startTime).getTime() - 30 * MIN),
    });
  }
  // How many usable open plans this user could see right now (only shown when >= 2).
  for (const o of out) o.vars.open_plan_count = out.length;
  return out;
}

async function revalidate(doc, user, now, cfg) {
  if (!mongoose.isValidObjectId(doc.eventRef.id)) return { ok: false, reason: 'EVENT_INVALID' };
  const plan = await SportsPlan.findById(doc.eventRef.id)
    .select('sportType playerLimit playersJoined kickedPlayers creatorId cardStatus startTime').lean();
  if (!plan) return { ok: false, reason: 'EVENT_DELETED' };
  const theirs = await User.find({ blockedUsers: user._id }).select('_id').lean();
  const blockedSet = new Set([...(user.blockedUsers || []).map(String), ...theirs.map(t => String(t._id))]);
  const why = planUsable(plan, user._id, blockedSet, now, 30 * MIN);
  return why ? { ok: false, reason: `EVENT_${why}` } : { ok: true };
}

module.exports = { category: 'SPORTS', eventType: 'SPORTS_PLAN', collect, revalidate, _internal: { planUsable } };
