// services/engagement/sources/nearbyMembers.js
// NEARBY — "New people have joined Humrah in your area."
//
// Privacy: only a COUNT is computed, and only shown as generic copy (no number, no
// name, no distance). The count must reach ENGAGEMENT_NEW_MEMBERS_MIN (default 3) so a
// single newcomer can never be inferred. People either side of a block are not counted.
// At most one such notification per user per calendar week bucket (the event key).
'use strict';

const User = require('../../../models/User');

const DAY = 24 * 3600 * 1000;
const EARTH_RADIUS_KM = 6378.1;

const weekBucket = now => Math.floor(now / (7 * DAY));

async function collect(ctx) {
  if (!ctx.point) return [];
  const { cfg, now } = ctx;
  const count = await User.countDocuments({
    _id: { $nin: [ctx.userId, ...ctx.blocked.list] },
    status: 'ACTIVE',
    role: 'USER',
    deletionRequestedAt: null,
    createdAt: { $gte: new Date(now - cfg.newMembersLookbackMs) },
    liveLocation: { $geoWithin: { $centerSphere: [ctx.point, ctx.radiusKm / EARTH_RADIUS_KM] } },
  }, { limit: 50 });
  if (count < cfg.newMembersMinCount) return [];
  const bucket = weekBucket(now);
  return [{
    category: 'NEARBY',
    eventType: 'NEARBY_NEW_MEMBERS',
    eventRef: { kind: 'AreaDigest', id: `W${bucket}` },
    eventKey: `NEARBY_NEW_MEMBERS:W${bucket}`,
    purpose: 'new_members',
    // A count (>= the minimum, never an identity) and the recipient's own area label.
    vars: { new_member_count: count, area_label: ctx.areaLabel },
    relevance: Math.min(1, 0.6 + count / 50),
    relevantUntil: new Date(now + 3 * DAY),
  }];
}

// An area digest has no single object that can disappear; it stays valid until
// relevantUntil, which the processor checks for every event type.
async function revalidate() { return { ok: true }; }

module.exports = { category: 'NEARBY', eventType: 'NEARBY_NEW_MEMBERS', collect, revalidate, _internal: { weekBucket } };
