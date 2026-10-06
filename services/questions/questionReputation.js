// services/questions/questionReputation.js
// -----------------------------------------------------------------------------
// Ask a Question — Phase 6 Replier Level & reputation. SERVER-AUTHORITATIVE: the app never
// awards anything; it only shows what this service decided.
//
//   +10  a valid answer (after validation, moderation and the save) — once per (user, question)
//   +15  the question's asker marks the answer "✓ Helpful" — once per answer, asker only
//   ≤25  from one answer;  ≤100 a day from answers (India time; Helpful is not capped)
//   0    replies, asking, answering your own question (refused anyway); no negative points
//
// Every award is a row in the append-only ledger (QuestionReputationEvent, unique dedupeKey),
// then an atomic $inc on the summary (QuestionReputation). The daily cap is one conditional
// update on the summary, so concurrent answers cannot pass it. A level crossed is announced
// once, ever ($addToSet claim on notifiedLevels).
//
// Levels: 0 New · 100 Helpful · 500 Active · 1,000 Pro · 2,000 Trusted Replier. Other people
// see only the level, never the points.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const Question = require('../../models/Question');
const QuestionAnswer = require('../../models/QuestionAnswer');
const QuestionReputation = require('../../models/QuestionReputation');
const QuestionReputationEvent = require('../../models/QuestionReputationEvent');
const QuestionAuditLog = require('../../models/QuestionAuditLog');
const User = require('../../models/User');

const notifications = () => require('./questionNotifications');

const POINTS = Object.freeze({ ANSWER: 10, HELPFUL: 15, DAILY_ANSWER_CAP: 100 });
const LEVELS = Object.freeze([
  { key: 'NEW', title: 'New Replier', min: 0 },
  { key: 'HELPFUL', title: 'Helpful Replier', min: 100 },
  { key: 'ACTIVE', title: 'Active Replier', min: 500 },
  { key: 'PRO', title: 'Pro Replier', min: 1000 },
  { key: 'TRUSTED', title: 'Trusted Replier', min: 2000 },
]);

const same = (a, b) => a != null && b != null && String(a) === String(b);
const isId = v => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const fail = (status, code, message, extra = {}) => ({ success: false, status, code, message, ...extra });

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The cap's day: YYYY-MM-DD in India time. */
const dayKey = (at = new Date()) => DAY_FMT.format(at);

function levelIndex(points) {
  let i = 0;
  for (let k = 0; k < LEVELS.length; k++) if (points >= LEVELS[k].min) i = k;
  return i;
}
const levelFor = points => LEVELS[levelIndex(Math.max(0, points | 0))];

/** Where a total sits: its level, the next one, how far along, how many points to go. */
function progressFor(points) {
  const p = Math.max(0, points | 0);
  const i = levelIndex(p);
  const level = LEVELS[i];
  const next = LEVELS[i + 1] || null;
  const span = next ? next.min - level.min : 1;
  return {
    points: p,
    level: { key: level.key, title: level.title, min: level.min },
    nextLevel: next ? { key: next.key, title: next.title, min: next.min, remaining: next.min - p } : null,
    progress: next ? Math.min(1, Math.max(0, (p - level.min) / span)) : 1,
  };
}

async function audit(event, fields) {
  try { await QuestionAuditLog.create({ event, actorId: null, ...fields }); }
  catch (err) { console.error('[REPUTATION] audit failed:', err && err.name); }
}

/** Adds to the summary and, if a level was crossed, claims and sends its push (once, ever). */
async function credit(userId, points, fields, now) {
  const after = await QuestionReputation.findOneAndUpdate(
    { userId },
    { $inc: { points, ...fields } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  const before = after.points - points;
  const from = levelIndex(before), to = levelIndex(after.points);
  let levelUp = null;
  if (to > from) {
    const lvl = LEVELS[to];
    levelUp = { key: lvl.key, title: lvl.title };
    const won = await QuestionReputation.updateOne({ userId, notifiedLevels: { $ne: lvl.key } }, { $addToSet: { notifiedLevels: lvl.key } });
    if (won.modifiedCount) {
      await audit('REPUTATION_LEVEL_UP', { targetUserId: userId, meta: { level: lvl.key } });
      try { notifications().dispatch(() => notifications().notifyLevelUp(userId, lvl.key, now)); } catch (_) { /* never fails the caller */ }
    }
  }
  return { before, after: after.points, levelUp };
}

/** Claims +10 of today's +100 answer allowance atomically. False when the day is full. */
async function claimDailyAnswerPoints(userId, day) {
  const room = POINTS.DAILY_ANSWER_CAP - POINTS.ANSWER;
  // A duplicate-key error means the row exists and the filter refused it (the day is full) —
  // or that two first-ever claims raced to create the row; one retry, against the row that
  // now exists, tells the two apart.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await QuestionReputation.findOneAndUpdate(
        { userId, $or: [{ capDay: { $ne: day } }, { capPoints: { $lte: room } }] },
        [{ $set: { capPoints: { $cond: [{ $eq: ['$capDay', day] }, { $add: ['$capPoints', POINTS.ANSWER] }, POINTS.ANSWER] }, capDay: day } }],
        { new: true, upsert: true },
      ).lean();
      return !!r;
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
    }
  }
  return false;
}
function releaseDailyAnswerPoints(userId, day) {
  return QuestionReputation.updateOne({ userId, capDay: day, capPoints: { $gte: POINTS.ANSWER } }, { $inc: { capPoints: -POINTS.ANSWER } });
}

/**
 * +10 for an answer that was just validated, moderated and saved (questionService.createAnswer).
 * Once per (user, question): an answer deleted and written again earns nothing more. Never throws.
 * @returns { awarded, points?, levelUp?, capped?, reason? }
 */
const currentPoints = async userId => ((await QuestionReputation.findOne({ userId }).select('points').lean()) || { points: 0 }).points;

async function awardAnswer({ userId, questionId, answerId }, now = new Date()) {
  try {
    const day = dayKey(now);
    const dedupeKey = `ANSWER_CREATED:${userId}:${questionId}`;
    if (await QuestionReputationEvent.exists({ dedupeKey })) return { awarded: 0, reason: 'already_awarded', points: await currentPoints(userId) };
    const ok = await claimDailyAnswerPoints(userId, day);
    try {
      await QuestionReputationEvent.create({ userId, questionId, answerId, eventType: 'ANSWER_CREATED', points: ok ? POINTS.ANSWER : 0, capped: !ok, day, dedupeKey, createdAt: now });
    } catch (err) {
      if (ok) await releaseDailyAnswerPoints(userId, day);
      if (err && err.code === 11000) return { awarded: 0, reason: 'already_awarded', points: await currentPoints(userId) };
      throw err;
    }
    if (!ok) return { awarded: 0, capped: true, points: await currentPoints(userId) };
    const c = await credit(userId, POINTS.ANSWER, { answerPoints: POINTS.ANSWER, answersCounted: 1 }, now);
    return { awarded: POINTS.ANSWER, points: c.after, levelUp: c.levelUp, first: c.before === 0 };
  } catch (err) {
    console.error('[REPUTATION] answer award failed:', err && err.name);
    return { awarded: 0, reason: 'error' };
  }
}

/**
 * POST /api/questions/:questionId/answers/:answerId/helpful — the asker's "✓ Helpful".
 * [loadVisible] / [answerView] come from questionService (the same visibility rules).
 */
async function markHelpful(user, questionId, answerId, { loadVisible, isBlockedPair, answerView, now = new Date() }) {
  const v = await loadVisible(user, questionId);
  if (v.error) return v.error;
  const { q, isOwner } = v;
  if (!isOwner) return fail(403, 'HELPFUL_NOT_QUESTION_OWNER', 'Only the person who asked can mark an answer Helpful.');
  if (q.status === 'HIDDEN') return fail(409, 'QUESTION_NOT_AVAILABLE', 'This question is not available.');
  if (!isId(answerId)) return fail(404, 'ANSWER_NOT_FOUND', 'This answer is not available.');
  const a = await QuestionAnswer.findOne({ _id: answerId, questionId: q._id, status: 'ACTIVE' }).lean();
  if (!a) return fail(404, 'ANSWER_NOT_FOUND', 'This answer is not available.');
  if (same(a.authorId, user._id)) return fail(403, 'HELPFUL_OWN_ANSWER', 'You can’t mark your own answer Helpful.');
  if (await isBlockedPair(user, a.authorId)) return fail(404, 'ANSWER_NOT_FOUND', 'This answer is not available.');
  const author = await User.findById(a.authorId).select('_id firstName profilePhoto verified photoVerificationStatus status').lean();
  if (!author || author.status !== 'ACTIVE') return fail(404, 'ANSWER_NOT_FOUND', 'This answer is not available.');

  // Once per answer: of two taps, two devices or two servers, exactly one gets past this.
  const claimed = await QuestionAnswer.findOneAndUpdate(
    { _id: a._id, status: 'ACTIVE', helpfulAt: null },
    { $set: { helpfulAt: now, helpfulBy: user._id } },
    { new: true },
  ).lean();
  if (!claimed) {
    const fresh = await QuestionAnswer.findById(a._id).lean();
    if (!fresh || fresh.status !== 'ACTIVE') return fail(404, 'ANSWER_NOT_FOUND', 'This answer is not available.');
    return { success: true, status: 200, alreadyHelpful: true, answer: answerView(fresh, { viewer: user, author, question: q }) };
  }
  let awarded = 0;
  try {
    await QuestionReputationEvent.create({ userId: a.authorId, questionId: q._id, answerId: a._id, eventType: 'ANSWER_HELPFUL', points: POINTS.HELPFUL, markedBy: user._id, day: dayKey(now), dedupeKey: `ANSWER_HELPFUL:${a._id}`, createdAt: now });
    awarded = POINTS.HELPFUL;
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;
  }
  if (awarded) {
    await credit(a.authorId, POINTS.HELPFUL, { helpfulPoints: POINTS.HELPFUL, helpfulCount: 1 }, now);
    await audit('ANSWER_MARKED_HELPFUL', { actorId: user._id, questionId: q._id, answerId: a._id, targetUserId: a.authorId, meta: { points: POINTS.HELPFUL } });
    try { notifications().dispatch(() => notifications().notifyHelpful(String(a._id), now)); } catch (_) { /* never fails the caller */ }
  }
  return { success: true, status: 200, helpful: { awarded }, answer: answerView(claimed, { viewer: user, author, question: q }) };
}

/** Levels of many users at once (an answer list). Map of id → level key; missing = NEW. */
async function levelsOf(userIds) {
  const ids = [...new Set(userIds.map(String))].filter(id => mongoose.isValidObjectId(id));
  if (!ids.length) return new Map();
  const rows = await QuestionReputation.find({ userId: { $in: ids } }).select('userId points').lean();
  const m = new Map(rows.map(r => [String(r.userId), levelFor(r.points).key]));
  for (const id of ids) if (!m.has(id)) m.set(id, 'NEW');
  return m;
}

const PREVIEW_MAX = 80;
const clip = t => { const s = String(t || '').replace(/\s+/g, ' ').trim(); const g = Array.from(s); return g.length <= PREVIEW_MAX ? s : `${g.slice(0, PREVIEW_MAX - 1).join('').trimEnd()}…`; };

/**
 * GET /api/questions/mine/reputation?before=<eventId>&limit= — the viewer's own level, points,
 * progress, today's answer allowance and history (newest first). A question that is gone,
 * hidden or now behind a block shows no text.
 */
async function myReputation(user, query = {}, { isBlockedPair } = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 50);
  const filter = { userId: user._id };
  if (query.before !== undefined) {
    if (!isId(String(query.before))) return fail(400, 'REPUTATION_INVALID_CURSOR', 'Invalid cursor.');
    const cur = await QuestionReputationEvent.findOne({ _id: String(query.before), userId: user._id }).select('createdAt').lean();
    if (cur) filter.$or = [{ createdAt: { $lt: cur.createdAt } }, { createdAt: cur.createdAt, _id: { $lt: cur._id } }];
  }
  const [summary, rows] = await Promise.all([
    QuestionReputation.findOne({ userId: user._id }).lean(),
    QuestionReputationEvent.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean(),
  ]);
  const page = rows.slice(0, limit);
  const qs = page.length ? await Question.find({ _id: { $in: [...new Set(page.map(r => String(r.questionId)))] } }).select('text status askerId').lean() : [];
  const byQ = new Map(qs.map(x => [String(x._id), x]));
  const visible = new Map();
  for (const x of qs) {
    const blocked = isBlockedPair ? await isBlockedPair(user, x.askerId) : false;
    visible.set(String(x._id), !blocked && x.status !== 'DELETED' && x.status !== 'HIDDEN');
  }
  const today = dayKey();
  const points = summary ? summary.points : 0;
  return {
    success: true,
    status: 200,
    reputation: {
      ...progressFor(points),
      levels: LEVELS.map(l => ({ key: l.key, title: l.title, min: l.min })),
      today: { answerPoints: summary && summary.capDay === today ? summary.capPoints : 0, answerCap: POINTS.DAILY_ANSWER_CAP },
      counts: { answers: summary ? summary.answersCounted : 0, helpful: summary ? summary.helpfulCount : 0 },
      rules: { answer: POINTS.ANSWER, helpful: POINTS.HELPFUL, maxPerAnswer: POINTS.ANSWER + POINTS.HELPFUL, dailyAnswerCap: POINTS.DAILY_ANSWER_CAP },
    },
    history: page.map(r => {
      const qx = byQ.get(String(r.questionId));
      const show = !!(qx && visible.get(String(r.questionId)));
      return {
        id: String(r._id), type: r.eventType, points: r.points, capped: !!r.capped, createdAt: new Date(r.createdAt).toISOString(),
        questionId: String(r.questionId), answerId: String(r.answerId),
        questionPreview: show ? clip(qx.text) : null, questionAvailable: show,
      };
    }),
    hasMore: rows.length > limit,
    nextBefore: rows.length > limit ? String(page[page.length - 1]._id) : null,
  };
}

/** Recomputes a user's summary from the ledger (repair / audit). Keeps cap and notified levels. */
async function rebuildFromLedger(userId) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const [agg] = await QuestionReputationEvent.aggregate([
    { $match: { userId: uid } },
    { $group: {
      _id: null,
      points: { $sum: '$points' },
      answerPoints: { $sum: { $cond: [{ $eq: ['$eventType', 'ANSWER_CREATED'] }, '$points', 0] } },
      helpfulPoints: { $sum: { $cond: [{ $eq: ['$eventType', 'ANSWER_HELPFUL'] }, '$points', 0] } },
      answersCounted: { $sum: { $cond: [{ $and: [{ $eq: ['$eventType', 'ANSWER_CREATED'] }, { $gt: ['$points', 0] }] }, 1, 0] } },
      helpfulCount: { $sum: { $cond: [{ $eq: ['$eventType', 'ANSWER_HELPFUL'] }, 1, 0] } },
    } },
  ]);
  const s = agg || { points: 0, answerPoints: 0, helpfulPoints: 0, answersCounted: 0, helpfulCount: 0 };
  await QuestionReputation.updateOne({ userId: uid }, { $set: { points: s.points, answerPoints: s.answerPoints, helpfulPoints: s.helpfulPoints, answersCounted: s.answersCounted, helpfulCount: s.helpfulCount } }, { upsert: true });
  return s;
}

module.exports = {
  POINTS, LEVELS, levelFor, levelIndex, progressFor, dayKey,
  awardAnswer, markHelpful, levelsOf, myReputation, rebuildFromLedger,
};
