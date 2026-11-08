// services/engagement/sources/communityQuestions.js
// COMMUNITY — new public questions (Ask a Question) in the user's area.
//
// Same visibility as the Questions feed: ACTIVE, not expired, within the Questions
// radius (questionRules RADIUS_M, 10 km) measured on the ~1 km locationGrid (never an
// exact point), not asked by the user or by anyone blocked either way, not hidden or
// reported by the user, and not under moderation (FLAGGED / UNDER_REVIEW).
// The copy never quotes a question or names who asked.
'use strict';

const mongoose = require('mongoose');
const Question = require('../../../models/Question');
const QuestionHide = require('../../../models/QuestionHide');
const User = require('../../../models/User');
const { LIMITS } = require('../../questions/questionRules');

const VISIBLE_MODERATION = ['ALLOWED', 'REVIEWED'];

async function collect(ctx) {
  if (!ctx.point) return [];
  const { cfg, now } = ctx;
  const radiusM = Math.min(ctx.radiusKm * 1000, LIMITS.RADIUS_M);
  const rows = await Question.aggregate([
    { $geoNear: {
      near: { type: 'Point', coordinates: ctx.point },
      distanceField: 'd', maxDistance: radiusM, spherical: true, key: 'locationGrid',
      query: {
        status: 'ACTIVE',
        expiresAt: { $gt: new Date(now + cfg.questionMinRemainingMs) },
        createdAt: { $gte: new Date(now - cfg.questionMaxAgeMs) },
        askerId: { $nin: [ctx.userId, ...ctx.blocked.list] },
        moderationState: { $in: VISIBLE_MODERATION },
      },
    } },
    { $limit: 20 },
    { $project: { _id: 1, createdAt: 1, expiresAt: 1 } },
  ]);
  if (rows.length === 0) return [];
  const hidden = await QuestionHide.find({ userId: ctx.userId, questionId: { $in: rows.map(r => r._id) } }).select('questionId').lean();
  const hiddenSet = new Set(hidden.map(h => String(h.questionId)));
  const visible = rows.filter(r => !hiddenSet.has(String(r._id)))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || String(b._id).localeCompare(String(a._id)));
  if (visible.length === 0) return [];
  const newest = visible[0];
  return [{
    category: 'COMMUNITY',
    eventType: 'COMMUNITY_QUESTIONS',
    // Keyed by the newest question: a later batch of new questions is a new event.
    eventRef: { kind: 'Question', id: String(newest._id) },
    eventKey: `COMMUNITY_QUESTIONS:${newest._id}`,
    templateKey: 'community.nearby_questions',
    vars: {},
    relevance: Math.min(1, 0.6 + 0.1 * visible.length),
    relevantUntil: new Date(new Date(newest.expiresAt).getTime() - cfg.questionMinRemainingMs),
  }];
}

async function revalidate(doc, user, now) {
  if (!mongoose.isValidObjectId(doc.eventRef.id)) return { ok: false, reason: 'EVENT_INVALID' };
  const q = await Question.findById(doc.eventRef.id).select('status expiresAt askerId moderationState').lean();
  if (!q) return { ok: false, reason: 'EVENT_DELETED' };
  if (q.status !== 'ACTIVE' || new Date(q.expiresAt).getTime() <= now) return { ok: false, reason: 'EVENT_NOT_ACTIVE' };
  if (!VISIBLE_MODERATION.includes(q.moderationState)) return { ok: false, reason: 'EVENT_UNDER_MODERATION' };
  if ((user.blockedUsers || []).map(String).includes(String(q.askerId))) return { ok: false, reason: 'EVENT_BLOCKED' };
  if (await User.exists({ _id: q.askerId, blockedUsers: user._id })) return { ok: false, reason: 'EVENT_BLOCKED' };
  if (await QuestionHide.exists({ userId: user._id, questionId: q._id })) return { ok: false, reason: 'EVENT_HIDDEN' };
  return { ok: true };
}

module.exports = { category: 'COMMUNITY', eventType: 'COMMUNITY_QUESTIONS', collect, revalidate };
