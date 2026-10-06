// services/questions/questionAdminService.js
// -----------------------------------------------------------------------------
// Ask a Question — admin operations (Phase 2B). Used only by routes/adminQuestions.js,
// which sits behind authenticate + adminOnly and checks a permission per route
// (questionAdminPermissions.js). Nothing here is reachable from user routes.
//
// RULES
//   • Every number comes from the database (aggregation pipelines on indexed fields,
//     bounded by the chosen period; results cached 60 s).
//   • Period metrics use the chosen period; current-state metrics (active now, open
//     reports, restricted now…) never do.
//   • Every admin action needs a reason (enforcement) and is written to the existing
//     AuditLog (admin id, role, email, action, target, reason, internal note).
//   • Nothing here touches an account: no suspension, ban, strike or general restriction.
//     The only enforcement is the QUESTION-CREATION-ONLY restriction, applied by an admin.
//   • No coordinates leave this file. Questions keep only a ~1 km grid cell, which the
//     admin API never returns.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const Question = require('../../models/Question');
const QuestionAnswer = require('../../models/QuestionAnswer');
const QuestionReply = require('../../models/QuestionReply');
const QuestionReport = require('../../models/QuestionReport');
const QuestionRestriction = require('../../models/QuestionRestriction');
const QuestionModerationRecord = require('../../models/QuestionModerationRecord');
const QuestionAuditLog = require('../../models/QuestionAuditLog');
const AuditLog = require('../../models/AuditLog');
const User = require('../../models/User');
const redis = require('../redisService');
const R = require('./questionRules');
const { PERMS, can } = require('./questionAdminPermissions');

const { ObjectId } = mongoose.Types;
const fail = (status, code, message, extra = {}) => ({ success: false, status, code, message, ...extra });
const ok = (body = {}) => ({ success: true, status: 200, ...body });
const isId = v => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const oid = v => new ObjectId(String(v));
const iso = d => (d ? new Date(d).toISOString() : null);
const preview = (t, n = 160) => (typeof t === 'string' ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : '');
const intIn = (raw, min, max, dflt) => { const n = parseInt(raw, 10); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt; };
const str = v => (typeof v === 'string' ? v : undefined);
const IST_MS = 330 * 60 * 1000;
const HOUR = 3600e3, DAY = 24 * HOUR;
const EXPIRING_SOON_MS = 2 * HOUR;

const ADMIN_USER_FIELDS = 'firstName lastName profilePhoto verified photoVerificationStatus createdAt status';
const personOf = u => (u ? {
  id: String(u._id),
  name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Unknown',
  profilePhoto: u.profilePhoto || null,
  verified: !!(u.verified === true || u.photoVerificationStatus === 'approved'),
  accountStatus: u.status || null,
  accountCreatedAt: iso(u.createdAt),
} : { id: null, name: 'Deleted account', profilePhoto: null, verified: false, accountStatus: null, accountCreatedAt: null });

async function peopleById(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))].filter(isId);
  if (!uniq.length) return new Map();
  const users = await User.find({ _id: { $in: uniq } }).select(ADMIN_USER_FIELDS).lean();
  return new Map(users.map(u => [String(u._id), u]));
}

const effectiveStatus = (q, now = Date.now()) => (q.status === 'ACTIVE' && new Date(q.expiresAt).getTime() <= now ? 'EXPIRED' : q.status);

// ── Reasons, notes, audit ──────────────────────────────────────────────────────

/** Enforcement needs a reason (3–300 chars); the internal note is optional (≤ 1000). */
function readReason(body = {}, { required = true } = {}) {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (required && (reason.length < 3 || reason.length > 300)) return { error: fail(400, 'ADMIN_REASON_REQUIRED', 'Please give a reason (3–300 characters).') };
  if (!required && reason.length > 300) return { error: fail(400, 'ADMIN_REASON_REQUIRED', 'Please keep the reason under 300 characters.') };
  if (note.length > 1000) return { error: fail(400, 'ADMIN_NOTE_TOO_LONG', 'Please keep the internal note under 1000 characters.') };
  return { reason: reason || null, note: note || null };
}

/** The existing admin audit log: who, what, which target, why, internal note. No user content. */
async function adminAudit(admin, action, targetType, targetId, { reason = null, note = null, details = {}, req = null } = {}) {
  const log = await AuditLog.logAction({
    actorId: admin._id, actorRole: admin.role, actorEmail: admin.email || 'unknown',
    action, targetType, targetId: targetId ? oid(targetId) : undefined,
    reason: reason || undefined,
    details: { ...details, ...(note ? { internalNote: note } : {}) },
    ipAddress: req ? req.ip : undefined, userAgent: req ? req.get('user-agent') : undefined,
    requestMethod: req ? req.method : undefined, requestPath: req ? req.originalUrl.split('?')[0] : undefined,
  });
  if (!log) console.error('[QUESTIONS-ADMIN] audit write failed:', action);
  return log;
}

// ── Periods (Asia/Kolkata calendar days, as the main dashboard) ───────────────

const RANGES = { today: 1, '7d': 7, '30d': 30, '90d': 90, all: null };
function istDayStart(t = Date.now()) {
  const shifted = new Date(t + IST_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST_MS);
}
function periodOf(range) {
  const key = Object.prototype.hasOwnProperty.call(RANGES, range) ? range : '7d';
  const days = RANGES[key];
  const today = istDayStart();
  return { key, start: days ? new Date(today.getTime() - (days - 1) * DAY) : null, today };
}
const inPeriod = (field, start) => (start ? { [field]: { $gte: start } } : {});
const dayKey = field => ({ $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: 'Asia/Kolkata' } });
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
const avgOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

// ── Stats (KPIs, analytics, categories, reports, moderation, health) ───────────

async function computeStats(range) {
  const { key, start, today } = periodOf(range);
  const now = new Date();
  const seriesStart = start || new Date(today.getTime() - 179 * DAY);      // time series: at most 180 days
  const restrictedNowFilter = { $or: [{ final: true }, { restrictedUntil: { $gt: now } }] };

  const [qFacet, current, answers, reports, mod, restrictedNow, totalAllTime, answersAllTime] = await Promise.all([
    Question.aggregate([
      { $match: inPeriod('createdAt', start) },
      { $facet: {
        totals: [{ $group: {
          _id: null,
          created: { $sum: 1 },
          answered: { $sum: { $cond: [{ $gt: ['$answerCount', 0] }, 1, 0] } },
          zero: { $sum: { $cond: [{ $eq: ['$answerCount', 0] }, 1, 0] } },
          multiple: { $sum: { $cond: [{ $gte: ['$answerCount', 2] }, 1, 0] } },
          answersSum: { $sum: '$answerCount' },
          expired: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'EXPIRED'] }, { $and: [{ $eq: ['$status', 'ACTIVE'] }, { $lte: ['$expiresAt', now] }] }] }, 1, 0] } },
          expiredUnanswered: { $sum: { $cond: [{ $and: [{ $eq: ['$answerCount', 0] }, { $or: [{ $eq: ['$status', 'EXPIRED'] }, { $and: [{ $eq: ['$status', 'ACTIVE'] }, { $lte: ['$expiresAt', now] }] }] }] }, 1, 0] } },
          closed: { $sum: { $cond: [{ $eq: ['$status', 'CLOSED'] }, 1, 0] } },
          deleted: { $sum: { $cond: [{ $eq: ['$status', 'DELETED'] }, 1, 0] } },
          hidden: { $sum: { $cond: [{ $eq: ['$status', 'HIDDEN'] }, 1, 0] } },
          reported: { $sum: { $cond: [{ $gt: ['$reportCount', 0] }, 1, 0] } },
          ttfaAvg: { $avg: '$timeToFirstAnswerMs' },
        } }],
        byDay: [{ $match: { createdAt: { $gte: seriesStart } } }, { $group: { _id: dayKey('createdAt'), questions: { $sum: 1 } } }, { $sort: { _id: 1 } }],
        byCategory: [{ $group: {
          _id: '$category', questions: { $sum: 1 }, answers: { $sum: '$answerCount' },
          answered: { $sum: { $cond: [{ $gt: ['$answerCount', 0] }, 1, 0] } }, ttfaAvg: { $avg: '$timeToFirstAnswerMs' }, reports: { $sum: '$reportCount' },
        } }],
      } },
    ]),
    Question.aggregate([
      { $match: { status: 'ACTIVE', expiresAt: { $gt: now } } },
      { $group: { _id: null, active: { $sum: 1 }, unanswered: { $sum: { $cond: [{ $eq: ['$answerCount', 0] }, 1, 0] } },
        expiringSoon: { $sum: { $cond: [{ $lte: ['$expiresAt', new Date(now.getTime() + EXPIRING_SOON_MS)] }, 1, 0] } } } },
    ]),
    QuestionAnswer.aggregate([
      { $match: inPeriod('createdAt', start) },
      { $facet: {
        total: [{ $count: 'n' }],
        today: [{ $match: { createdAt: { $gte: today } } }, { $count: 'n' }],
        byDay: [{ $match: { createdAt: { $gte: seriesStart } } }, { $group: { _id: dayKey('createdAt'), answers: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      } },
    ]),
    QuestionReport.aggregate([
      { $facet: {
        openNow: [{ $match: { status: { $in: ['OPEN', 'UNDER_REVIEW'] } } }, { $count: 'n' }],
        today: [{ $match: { createdAt: { $gte: today } } }, { $count: 'n' }],
        week: [{ $match: { createdAt: { $gte: new Date(today.getTime() - 6 * DAY) } } }, { $count: 'n' }],
        period: [{ $match: inPeriod('createdAt', start) }, { $group: {
          _id: null, total: { $sum: 1 },
          questions: { $addToSet: { $cond: [{ $eq: ['$targetType', 'QUESTION'] }, '$targetId', '$$REMOVE'] } },
          answers: { $addToSet: { $cond: [{ $eq: ['$targetType', 'ANSWER'] }, '$targetId', '$$REMOVE'] } },
          resolved: { $sum: { $cond: [{ $eq: ['$status', 'RESOLVED'] }, 1, 0] } },
          dismissed: { $sum: { $cond: [{ $eq: ['$status', 'DISMISSED'] }, 1, 0] } },
          confirmed: { $sum: { $cond: [{ $eq: ['$resolution', 'VIOLATION_CONFIRMED'] }, 1, 0] } },
          resolutionMsAvg: { $avg: { $cond: [{ $ifNull: ['$resolvedAt', false] }, { $subtract: ['$resolvedAt', '$createdAt'] }, null] } },
        } }, { $project: { total: 1, resolved: 1, dismissed: 1, confirmed: 1, resolutionMsAvg: 1, questions: { $size: '$questions' }, answers: { $size: '$answers' } } }],
        byReason: [{ $match: inPeriod('createdAt', start) }, { $group: { _id: '$reason', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
        byCategory: [{ $match: inPeriod('createdAt', start) }, { $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
      } },
    ]),
    QuestionModerationRecord.aggregate([
      { $match: inPeriod('createdAt', start) },
      { $facet: {
        byTypeVerdict: [{ $group: { _id: { t: '$contentType', v: '$verdict' }, n: { $sum: 1 } } }],
        byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
        byCategory: [{ $match: { contentType: 'QUESTION' } }, { $group: { _id: '$category', n: { $sum: 1 } } }],
        byReason: [{ $group: { _id: '$reasonCode', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
      } },
    ]),
    QuestionRestriction.countDocuments(restrictedNowFilter),
    Question.estimatedDocumentCount(),
    QuestionAnswer.estimatedDocumentCount(),
  ]);
  const questionsToday = await Question.countDocuments({ createdAt: { $gte: today } });

  const t = (qFacet[0].totals[0]) || { created: 0, answered: 0, zero: 0, multiple: 0, answersSum: 0, expired: 0, expiredUnanswered: 0, closed: 0, deleted: 0, hidden: 0, reported: 0, ttfaAvg: null };
  const cur = current[0] || { active: 0, unanswered: 0, expiringSoon: 0 };
  const a = answers[0];
  const rp = reports[0];
  const rpp = rp.period[0] || { total: 0, questions: 0, answers: 0, resolved: 0, dismissed: 0, confirmed: 0, resolutionMsAvg: null };
  const m = mod[0];
  const tv = (type, verdict) => m.byTypeVerdict.filter(x => x._id.t === type && (!verdict || x._id.v === verdict)).reduce((s, x) => s + x.n, 0);
  const st = s => (m.byStatus.find(x => x._id === s) || { n: 0 }).n;
  const qRejected = tv('QUESTION', 'BLOCKED'), qFlagged = tv('QUESTION', 'REVIEW'), allRejections = tv('QUESTION') + tv('ANSWER') + tv('REPLY');
  const confirmed = st('CONFIRMED'), overturned = st('OVERTURNED');
  const modRejByCat = new Map(m.byCategory.map(x => [x._id, x.n]));
  const repByCat = new Map(rp.byCategory.map(x => [x._id, x.n]));

  // Fill every day of the series so charts have no holes.
  const days = [];
  for (let d = seriesStart; d <= today; d = new Date(d.getTime() + DAY)) {          // seriesStart is an IST day start
    days.push(new Date(d.getTime() + IST_MS).toISOString().slice(0, 10));
  }
  const qByDay = new Map(qFacet[0].byDay.map(x => [x._id, x.questions]));
  const aByDay = new Map(a.byDay.map(x => [x._id, x.answers]));
  const overTime = days.map(d => ({ date: d, questions: qByDay.get(d) || 0, answers: aByDay.get(d) || 0 }));

  const byCatMap = new Map(qFacet[0].byCategory.map(x => [x._id, x]));
  const categories = R.CATEGORIES.map(c => {
    const x = byCatMap.get(c) || { questions: 0, answers: 0, answered: 0, ttfaAvg: null };
    return { category: c, label: R.CATEGORY_LABELS[c], questions: x.questions, answers: x.answers, answerRate: rate(x.answered, x.questions),
      avgTimeToFirstAnswerMs: avgOrNull(x.ttfaAvg), reports: repByCat.get(c) || 0, moderationRejections: modRejByCat.get(c) || 0 };
  });

  const topOf = list => (list && list[0] && list[0]._id ? { key: list[0]._id, count: list[0].n } : null);
  return {
    range: key, periodStart: iso(start), generatedAt: now.toISOString(), timezone: 'Asia/Kolkata',
    kpis: {
      totalQuestions: totalAllTime,
      questionsToday,
      questionsInPeriod: t.created,
      activeQuestions: cur.active,                        // current state
      answeredQuestions: t.answered,                      // created in the period, ≥ 1 answer now
      unansweredQuestions: cur.unanswered,                // current state: active with 0 answers
      expiringSoon: cur.expiringSoon,                     // current state: active, closes within 2 h
      totalAnswers: answersAllTime,
      answersToday: a.today[0] ? a.today[0].n : 0,
      answersInPeriod: a.total[0] ? a.total[0].n : 0,
      openReports: rp.openNow[0] ? rp.openNow[0].n : 0,  // current state
      moderationRejections: allRejections,                // period
      restrictedCreators: restrictedNow,                  // current state
      avgTimeToFirstAnswerMs: avgOrNull(t.ttfaAvg),       // period
    },
    analytics: {
      overTime,
      answerRate: rate(t.answered, t.created),
      zeroAnswers: t.zero, oneOrMoreAnswers: t.answered, multipleAnswers: t.multiple,
      expirationRate: rate(t.expired, t.created),
      closeRate: rate(t.closed, t.created),
      moderationRejectionRate: rate(qRejected, qRejected + t.created),
      reportRate: rate(t.reported, t.created),
      deleted: t.deleted, hidden: t.hidden,
    },
    health: {
      answerRate: rate(t.answered, t.created),
      avgTimeToFirstAnswerMs: avgOrNull(t.ttfaAvg),
      reportRate: rate(t.reported, t.created),
      moderationRejectionRate: rate(qRejected, qRejected + t.created),
      expirationWithoutAnswerRate: rate(t.expiredUnanswered, t.expired),
      avgAnswersPerQuestion: t.created ? Math.round((t.answersSum / t.created) * 100) / 100 : null,
    },
    categories,
    reports: {
      openReports: rp.openNow[0] ? rp.openNow[0].n : 0,
      reportsToday: rp.today[0] ? rp.today[0].n : 0,
      reportsThisWeek: rp.week[0] ? rp.week[0].n : 0,
      reportsInPeriod: rpp.total,
      questionsReported: rpp.questions,
      answersReported: rpp.answers,
      mostReportedCategory: topOf(rp.byCategory),
      mostCommonReason: topOf(rp.byReason),
      byReason: rp.byReason.map(x => ({ reason: x._id, count: x.n })),
      avgResolutionMs: avgOrNull(rpp.resolutionMsAvg),
      dismissalRate: rate(rpp.dismissed, rpp.resolved + rpp.dismissed),
      confirmedViolationRate: rate(rpp.confirmed, rpp.resolved + rpp.dismissed),
    },
    moderation: {
      totalModeratedQuestions: t.created + tv('QUESTION'),
      allowed: t.created,
      rejected: qRejected,
      flagged: qFlagged,
      answerRejections: tv('ANSWER'), replyRejections: tv('REPLY'),
      pendingReview: st('PENDING_REVIEW'),
      adminConfirmed: confirmed,
      adminRestored: overturned,
      rejectionRate: rate(qRejected, qRejected + t.created),
      adminConfirmationRate: rate(confirmed, confirmed + overturned),
      adminOverrideRate: rate(overturned, confirmed + overturned),
      byReason: m.byReason.map(x => ({ reason: x._id, count: x.n })),
    },
  };
}

async function stats(query = {}) {
  const { key } = periodOf(query.range);
  const cacheKey = `qadmin:stats:${key}`;
  if (query.fresh !== '1') {
    try { const hit = await redis.get(cacheKey); if (hit) return ok({ stats: hit, cached: true }); } catch (_) { /* fail open */ }
  }
  const s = await computeStats(key);
  try { await redis.set(cacheKey, s, 60); } catch (_) { /* fail open */ }
  return ok({ stats: s, cached: false });
}

// ── Question list (search, filters, sort, server-side pagination) ─────────────

const SORTS = {
  newest:            { sort: { createdAt: -1, _id: -1 } },
  oldest:            { sort: { createdAt: 1, _id: 1 } },
  most_answers:      { sort: { answerCount: -1, createdAt: -1 } },
  least_answers:     { sort: { answerCount: 1, createdAt: -1 } },
  most_reported:     { sort: { reportCount: -1, createdAt: -1 } },
  recently_reported: { sort: { lastReportedAt: -1 }, match: { lastReportedAt: { $type: 'date' } } },
  fastest_answered:  { sort: { timeToFirstAnswerMs: 1 }, match: { timeToFirstAnswerMs: { $type: 'number' } } },
  slowest_answered:  { sort: { timeToFirstAnswerMs: -1 }, match: { timeToFirstAnswerMs: { $type: 'number' } } },
};
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function currentlyRestrictedUserIds(limit = 5000) {
  const now = new Date();
  return (await QuestionRestriction.find({ $or: [{ final: true }, { restrictedUntil: { $gt: now } }] }).select('userId').limit(limit).lean()).map(r => r.userId);
}

/** The filter for list + export. Returns { filter, sort } or { error }. */
async function buildQuestionFilter(q = {}) {
  const now = new Date();
  const and = [];
  const status = str(q.status);
  if (status) {
    if (!['ACTIVE', 'CLOSED', 'EXPIRED', 'DELETED', 'HIDDEN'].includes(status)) return { error: fail(400, 'ADMIN_INVALID_FILTER', 'Unknown status.') };
    if (status === 'ACTIVE') and.push({ status: 'ACTIVE', expiresAt: { $gt: now } });
    else if (status === 'EXPIRED') and.push({ $or: [{ status: 'EXPIRED' }, { status: 'ACTIVE', expiresAt: { $lte: now } }] });
    else and.push({ status });
  }
  const category = str(q.category);
  if (category) { if (!R.CATEGORIES.includes(category)) return { error: fail(400, 'ADMIN_INVALID_FILTER', 'Unknown category.') }; and.push({ category }); }
  const ms = str(q.moderation);
  if (ms) { if (!['ALLOWED', 'FLAGGED', 'UNDER_REVIEW', 'REVIEWED'].includes(ms)) return { error: fail(400, 'ADMIN_INVALID_FILTER', 'Unknown moderation state.') }; and.push({ moderationState: ms }); }
  if (q.reports === 'has') and.push({ reportCount: { $gt: 0 } });
  if (q.reports === 'none') and.push({ reportCount: 0 });
  if (q.minReports !== undefined) and.push({ reportCount: { $gte: intIn(q.minReports, 0, 1e6, 0) } });
  if (q.answered === 'yes') and.push({ answerCount: { $gt: 0 } });
  if (q.answered === 'no') and.push({ answerCount: 0 });
  const from = str(q.createdFrom) && !Number.isNaN(Date.parse(q.createdFrom)) ? new Date(q.createdFrom) : null;
  const to = str(q.createdTo) && !Number.isNaN(Date.parse(q.createdTo)) ? new Date(q.createdTo) : null;
  if (from || to) and.push({ createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } });
  if (q.restricted === 'true') and.push({ askerId: { $in: await currentlyRestrictedUserIds() } });

  const search = str(q.search) && q.search.trim().slice(0, 100);
  if (search) {
    if (isId(search)) {
      and.push({ $or: [{ _id: oid(search) }, { askerId: oid(search) }] });
    } else {
      const [textHits, people] = await Promise.all([
        Question.find({ $text: { $search: search } }).select('_id').limit(1000).lean(),
        User.find({ $or: [{ firstName: new RegExp(escapeRe(search), 'i') }, { lastName: new RegExp(escapeRe(search), 'i') }] }).select('_id').limit(200).lean(),
      ]);
      and.push({ $or: [{ _id: { $in: textHits.map(h => h._id) } }, { askerId: { $in: people.map(p => p._id) } }] });
    }
  }
  const s = SORTS[str(q.sort)] || SORTS.newest;
  if (s.match) and.push(s.match);
  return { filter: and.length ? { $and: and } : {}, sort: s.sort };
}

function questionRow(qd, people, now = Date.now()) {
  return {
    id: String(qd._id),
    textPreview: preview(qd.text),
    category: qd.category, categoryLabel: R.CATEGORY_LABELS[qd.category] || qd.category,
    asker: personOf(people.get(String(qd.askerId))),
    createdAt: iso(qd.createdAt), expiresAt: iso(qd.expiresAt),
    area: 'LOCAL_10KM',                         // local content; no precise area is stored or shown
    answerCount: qd.answerCount || 0, reportCount: qd.reportCount || 0,
    status: effectiveStatus(qd, now), moderationState: qd.moderationState || 'ALLOWED',
    timeToFirstAnswerMs: qd.timeToFirstAnswerMs ?? null,
  };
}

async function listQuestions(query = {}) {
  const f = await buildQuestionFilter(query);
  if (f.error) return f.error;
  const limit = intIn(query.limit, 1, 100, 25);
  const page = intIn(query.page, 1, 400, 1);
  const [rows, total] = await Promise.all([
    Question.find(f.filter).sort(f.sort).skip((page - 1) * limit).limit(limit).select('-normalizedText -clientRequestId -locationGrid').lean(),
    Question.countDocuments(f.filter),
  ]);
  const people = await peopleById(rows.map(r => r.askerId));
  return ok({ questions: rows.map(r => questionRow(r, people)), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
}

// ── Inspectors ─────────────────────────────────────────────────────────────────

async function restrictionSummary(userId) {
  const r = await QuestionRestriction.findOne({ userId }).lean();
  if (!r) return { current: null, level: 0, history: [] };
  const now = Date.now();
  const active = r.final || (r.restrictedUntil && new Date(r.restrictedUntil).getTime() > now);
  const adminIds = r.history.filter(h => h.by && h.by !== 'SYSTEM').map(h => h.by);
  const admins = await peopleById(adminIds);
  return {
    current: active ? { level: r.level, final: !!r.final, reason: r.restrictionReason, startedAt: iso(r.lastAppliedAt), endsAt: r.final ? null : iso(r.restrictedUntil) } : null,
    level: r.level,
    history: [...r.history].reverse().map(h => ({
      action: h.action, level: h.level, reason: h.reason, until: iso(h.until), final: !!h.final, at: iso(h.at), note: h.note || null,
      by: h.by === 'SYSTEM' ? { type: 'SYSTEM' } : { type: 'ADMIN', id: h.by, name: admins.get(String(h.by)) ? personOf(admins.get(String(h.by))).name : 'Admin' },
    })),
  };
}

async function questionDetail(questionId) {
  if (!isId(questionId)) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  const q = await Question.findById(questionId).select('-normalizedText -clientRequestId -locationGrid').lean();
  if (!q) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  const [answers, reports, askerQ, askerA, records, restriction] = await Promise.all([
    QuestionAnswer.find({ questionId: q._id }).sort({ createdAt: 1 }).limit(100).lean(),
    QuestionReport.find({ questionId: q._id }).sort({ createdAt: -1 }).limit(50).lean(),
    Question.countDocuments({ askerId: q.askerId }),
    QuestionAnswer.countDocuments({ authorId: q.askerId }),
    QuestionModerationRecord.find({ userId: q.askerId }).sort({ createdAt: -1 }).limit(10).select('contentType reasonCode severity verdict status createdAt').lean(),
    restrictionSummary(q.askerId),
  ]);
  const people = await peopleById([q.askerId, q.hiddenBy, ...answers.map(a => a.authorId), ...reports.map(r => r.reporterId)]);
  return ok({
    question: {
      ...questionRow(q, people), text: q.text,
      tags: (q.tags || []).map(k => ({ key: k, label: R.TAG_LABELS[k] || k })),
      closedAt: iso(q.closedAt), deletedAt: iso(q.deletedAt), hiddenAt: iso(q.hiddenAt), hiddenReason: q.hiddenReason || null,
      hiddenBy: q.hiddenBy ? personOf(people.get(String(q.hiddenBy))).name : null,
      firstAnswerAt: iso(q.firstAnswerAt), restoredFromModeration: !!q.restoredFromRecordId,
    },
    asker: {
      ...personOf(people.get(String(q.askerId))),
      questionCount: askerQ, answerCount: askerA,
      restriction,
      moderationHistory: records.map(r => ({ id: String(r._id), contentType: r.contentType, reasonCode: r.reasonCode, severity: r.severity, verdict: r.verdict, status: r.status, at: iso(r.createdAt) })),
    },
    answers: answers.map(a => ({
      id: String(a._id), text: a.text, createdAt: iso(a.createdAt), author: personOf(people.get(String(a.authorId))),
      reportCount: a.reportCount || 0, moderationState: a.moderationState || 'ALLOWED', status: a.status, replyCount: a.replyCount || 0,
      hiddenAt: iso(a.hiddenAt),
    })),
    reports: reports.map(r => ({ id: String(r._id), targetType: r.targetType, targetId: String(r.targetId), reason: r.reason, status: r.status, createdAt: iso(r.createdAt), reporter: personOf(people.get(String(r.reporterId))).name })),
  });
}

async function userHistory(userId) {
  if (!isId(userId)) return fail(404, 'ADMIN_USER_NOT_FOUND', 'User not found.');
  const u = await User.findById(userId).select(ADMIN_USER_FIELDS).lean();
  if (!u) return fail(404, 'ADMIN_USER_NOT_FOUND', 'User not found.');
  const now = new Date();
  const [byStatus, recent, rejections, reportsAgainst, answers, restriction] = await Promise.all([
    Question.aggregate([{ $match: { askerId: u._id } }, { $group: {
      _id: null, total: { $sum: 1 },
      active: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'ACTIVE'] }, { $gt: ['$expiresAt', now] }] }, 1, 0] } },
      closed: { $sum: { $cond: [{ $eq: ['$status', 'CLOSED'] }, 1, 0] } },
      expired: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'EXPIRED'] }, { $and: [{ $eq: ['$status', 'ACTIVE'] }, { $lte: ['$expiresAt', now] }] }] }, 1, 0] } },
      deleted: { $sum: { $cond: [{ $eq: ['$status', 'DELETED'] }, 1, 0] } },
      hidden: { $sum: { $cond: [{ $eq: ['$status', 'HIDDEN'] }, 1, 0] } },
    } }]),
    Question.find({ askerId: u._id }).sort({ createdAt: -1 }).limit(20).select('text category status expiresAt createdAt answerCount reportCount moderationState').lean(),
    QuestionModerationRecord.aggregate([{ $match: { userId: u._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    QuestionReport.aggregate([{ $match: { reportedUserId: u._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    QuestionAnswer.countDocuments({ authorId: u._id }),
    restrictionSummary(u._id),
  ]);
  // Phase 6: the user's Replier Level summary (read-only; the ledger stays the source).
  let reputation = null;
  try {
    const QR = require('../../models/QuestionReputation');
    const rs = await QR.findOne({ userId: u._id }).lean();
    const pts = rs ? rs.points : 0;
    reputation = { ...require('./questionReputation').progressFor(pts), answersCounted: rs ? rs.answersCounted : 0, helpfulCount: rs ? rs.helpfulCount : 0 };
  } catch (err) { console.error('[QUESTIONS_ADMIN] reputation summary failed:', err && err.name); }
  const s = byStatus[0] || { total: 0, active: 0, closed: 0, expired: 0, deleted: 0, hidden: 0 };
  const sum = list => list.reduce((x, y) => x + y.n, 0);
  return ok({
    user: personOf(u),
    questions: { total: s.total, active: s.active, closed: s.closed, expired: s.expired, deleted: s.deleted, hidden: s.hidden },
    answers,
    reputation,
    moderationRejections: { total: sum(rejections), byStatus: Object.fromEntries(rejections.map(x => [x._id, x.n])) },
    reportsAgainstContent: { total: sum(reportsAgainst), byStatus: Object.fromEntries(reportsAgainst.map(x => [x._id, x.n])) },
    restriction,
    recentQuestions: recent.map(q => ({ id: String(q._id), textPreview: preview(q.text, 120), category: q.category, status: effectiveStatus(q), createdAt: iso(q.createdAt), answerCount: q.answerCount, reportCount: q.reportCount || 0, moderationState: q.moderationState })),
  });
}

// ── Reports ────────────────────────────────────────────────────────────────────

async function contentFor(report) {
  const out = { question: null, answer: null, reply: null };
  const q = await Question.findById(report.questionId).select('text category status expiresAt reportCount moderationState askerId').lean();
  if (q) out.question = { id: String(q._id), text: q.text, textPreview: preview(q.text), category: q.category, status: effectiveStatus(q), reportCount: q.reportCount || 0, moderationState: q.moderationState };
  if (report.targetType === 'ANSWER') {
    const a = await QuestionAnswer.findById(report.targetId).select('text status reportCount moderationState').lean();
    if (a) out.answer = { id: String(a._id), text: a.text, textPreview: preview(a.text), status: a.status, reportCount: a.reportCount || 0, moderationState: a.moderationState };
  } else if (report.targetType === 'REPLY') {
    const r = await QuestionReply.findById(report.targetId).select('text status answerId').lean();
    if (r) out.reply = { id: String(r._id), text: r.text, textPreview: preview(r.text), status: r.status };
  }
  return out;
}

async function listReports(query = {}) {
  const and = [];
  const status = str(query.status);
  if (status) { if (!QuestionReport.STATUSES.includes(status)) return fail(400, 'ADMIN_INVALID_FILTER', 'Unknown report status.'); and.push({ status }); }
  const tt = str(query.targetType);
  if (tt) { if (!['QUESTION', 'ANSWER', 'REPLY'].includes(tt)) return fail(400, 'ADMIN_INVALID_FILTER', 'Unknown content type.'); and.push({ targetType: tt }); }
  const reason = str(query.reason);
  if (reason) { if (!QuestionReport.REASONS.includes(reason)) return fail(400, 'ADMIN_INVALID_FILTER', 'Unknown reason.'); and.push({ reason }); }
  if (query.escalated === 'true') and.push({ escalated: true });
  const category = str(query.category);
  if (category && R.CATEGORIES.includes(category)) and.push({ category });
  const filter = and.length ? { $and: and } : {};
  const limit = intIn(query.limit, 1, 100, 25);
  const page = intIn(query.page, 1, 400, 1);
  const sort = query.sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };
  const [rows, total] = await Promise.all([QuestionReport.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), QuestionReport.countDocuments(filter)]);
  const targetIds = [...new Set(rows.map(r => String(r.targetId)))].map(oid);
  const [counts, questions, answers, people] = await Promise.all([
    targetIds.length ? QuestionReport.aggregate([{ $match: { targetId: { $in: targetIds } } }, { $group: { _id: '$targetId', n: { $sum: 1 } } }]) : [],
    Question.find({ _id: { $in: rows.map(r => r.questionId) } }).select('text status expiresAt moderationState').lean(),
    QuestionAnswer.find({ _id: { $in: rows.filter(r => r.targetType === 'ANSWER').map(r => r.targetId) } }).select('text status moderationState').lean(),
    peopleById([...rows.map(r => r.reporterId), ...rows.map(r => r.reportedUserId), ...rows.map(r => r.assignedTo)]),
  ]);
  const countBy = new Map(counts.map(c => [String(c._id), c.n]));
  const qBy = new Map(questions.map(q => [String(q._id), q]));
  const aBy = new Map(answers.map(a => [String(a._id), a]));
  return ok({
    reports: rows.map(r => {
      const q = qBy.get(String(r.questionId)); const a = aBy.get(String(r.targetId));
      return {
        id: String(r._id), targetType: r.targetType, reason: r.reason, status: r.status, resolution: r.resolution, createdAt: iso(r.createdAt),
        question: q ? { id: String(q._id), textPreview: preview(q.text, 100), status: effectiveStatus(q) } : null,
        answer: r.targetType === 'ANSWER' && a ? { id: String(a._id), textPreview: preview(a.text, 100), status: a.status } : null,
        reporter: personOf(people.get(String(r.reporterId))), reportedUser: personOf(people.get(String(r.reportedUserId))),
        reportsOnContent: countBy.get(String(r.targetId)) || 1,
        moderationState: r.targetType === 'ANSWER' ? (a && a.moderationState) || null : (q && q.moderationState) || null,
        assignedTo: r.assignedTo ? personOf(people.get(String(r.assignedTo))).name : null,
        escalated: !!r.escalated,
      };
    }),
    page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)),
  });
}

async function reportDetail(reportId) {
  if (!isId(reportId)) return fail(404, 'ADMIN_REPORT_NOT_FOUND', 'Report not found.');
  const r = await QuestionReport.findById(reportId).lean();
  if (!r) return fail(404, 'ADMIN_REPORT_NOT_FOUND', 'Report not found.');
  const [content, sameContent, sameUser, records, restriction] = await Promise.all([
    contentFor(r),
    QuestionReport.find({ targetId: r.targetId, _id: { $ne: r._id } }).sort({ createdAt: -1 }).limit(20).lean(),
    QuestionReport.find({ reportedUserId: r.reportedUserId, targetId: { $ne: r.targetId } }).sort({ createdAt: -1 }).limit(20).lean(),
    QuestionModerationRecord.find({ userId: r.reportedUserId }).sort({ createdAt: -1 }).limit(10).select('contentType reasonCode severity verdict status createdAt').lean(),
    restrictionSummary(r.reportedUserId),
  ]);
  const people = await peopleById([r.reporterId, r.reportedUserId, r.reviewedBy, r.assignedTo, r.escalatedBy, ...sameContent.map(x => x.reporterId), ...sameUser.map(x => x.reporterId)]);
  const brief = x => ({ id: String(x._id), targetType: x.targetType, reason: x.reason, status: x.status, resolution: x.resolution, createdAt: iso(x.createdAt), reporter: personOf(people.get(String(x.reporterId))).name });
  return ok({
    report: {
      id: String(r._id), targetType: r.targetType, targetId: String(r.targetId), reason: r.reason, description: r.description || '',
      status: r.status, resolution: r.resolution, createdAt: iso(r.createdAt), reviewedAt: iso(r.reviewedAt), resolvedAt: iso(r.resolvedAt),
      reviewedBy: r.reviewedBy ? personOf(people.get(String(r.reviewedBy))).name : null,
      assignedTo: r.assignedTo ? personOf(people.get(String(r.assignedTo))).name : null,
      adminReason: r.adminReason, adminNote: r.adminNote, escalated: !!r.escalated, escalatedAt: iso(r.escalatedAt),
      escalatedBy: r.escalatedBy ? personOf(people.get(String(r.escalatedBy))).name : null,
    },
    content,
    reporter: personOf(people.get(String(r.reporterId))),
    reportedUser: personOf(people.get(String(r.reportedUserId))),
    relatedReports: { sameContent: sameContent.map(brief), sameUserOtherContent: sameUser.map(brief) },
    reportedUserModeration: records.map(x => ({ id: String(x._id), contentType: x.contentType, reasonCode: x.reasonCode, severity: x.severity, verdict: x.verdict, status: x.status, at: iso(x.createdAt) })),
    reportedUserRestriction: restriction,
  });
}

/** Moves the reported content's moderation state after a report changes. */
async function syncTargetModeration(r) {
  const M = r.targetType === 'QUESTION' ? Question : r.targetType === 'ANSWER' ? QuestionAnswer : null;
  if (!M) return;
  const open = await QuestionReport.countDocuments({ targetId: r.targetId, status: { $in: ['OPEN', 'UNDER_REVIEW'] } });
  const underReview = await QuestionReport.countDocuments({ targetId: r.targetId, status: 'UNDER_REVIEW' });
  const state = underReview ? 'UNDER_REVIEW' : open ? 'FLAGGED' : 'REVIEWED';
  await M.updateOne({ _id: r.targetId }, { $set: { moderationState: state } });
}

/** OPEN → UNDER_REVIEW → RESOLVED (with a resolution) | DISMISSED. Final states do not change. */
async function setReportStatus(admin, reportId, body = {}, req = null) {
  if (!isId(reportId)) return fail(404, 'ADMIN_REPORT_NOT_FOUND', 'Report not found.');
  const status = str(body.status);
  if (!['UNDER_REVIEW', 'RESOLVED', 'DISMISSED'].includes(status)) return fail(400, 'ADMIN_INVALID_STATUS', 'Status must be UNDER_REVIEW, RESOLVED or DISMISSED.');
  const resolution = status === 'RESOLVED' ? str(body.resolution) : null;
  if (status === 'RESOLVED' && !QuestionReport.RESOLUTIONS.includes(resolution)) return fail(400, 'ADMIN_INVALID_RESOLUTION', 'Choose VIOLATION_CONFIRMED or NO_VIOLATION.');
  const rr = readReason(body, { required: status !== 'UNDER_REVIEW' });
  if (rr.error) return rr.error;
  const now = new Date();
  const from = status === 'UNDER_REVIEW' ? ['OPEN'] : ['OPEN', 'UNDER_REVIEW'];
  const set = status === 'UNDER_REVIEW'
    ? { status, assignedTo: admin._id, reviewedBy: admin._id, reviewedAt: now }
    : { status, resolution, resolvedAt: now, reviewedBy: admin._id, reviewedAt: now, adminReason: rr.reason, ...(rr.note ? { adminNote: rr.note } : {}) };
  const r = await QuestionReport.findOneAndUpdate({ _id: reportId, status: { $in: from } }, { $set: set }, { new: true }).lean();
  if (!r) {
    const cur = await QuestionReport.findById(reportId).select('status').lean();
    if (!cur) return fail(404, 'ADMIN_REPORT_NOT_FOUND', 'Report not found.');
    return fail(409, 'ADMIN_REPORT_STATE', `This report is already ${cur.status}.`, { currentStatus: cur.status });
  }
  await syncTargetModeration(r);
  const action = { UNDER_REVIEW: 'QUESTION_REPORT_UNDER_REVIEW', RESOLVED: 'QUESTION_REPORT_RESOLVED', DISMISSED: 'QUESTION_REPORT_DISMISSED' }[status];
  await adminAudit(admin, action, 'QUESTION_REPORT', r._id, { reason: rr.reason, note: rr.note, details: { resolution, targetType: r.targetType, targetId: String(r.targetId) }, req });
  return ok({ report: { id: String(r._id), status: r.status, resolution: r.resolution } });
}

async function escalateReport(admin, reportId, body = {}, req = null) {
  if (!isId(reportId)) return fail(404, 'ADMIN_REPORT_NOT_FOUND', 'Report not found.');
  const rr = readReason(body);
  if (rr.error) return rr.error;
  const now = new Date();
  const r = await QuestionReport.findOneAndUpdate(
    { _id: reportId, status: { $in: ['OPEN', 'UNDER_REVIEW'] } },
    { $set: { escalated: true, escalatedAt: now, escalatedBy: admin._id, status: 'UNDER_REVIEW', assignedTo: admin._id, ...(rr.note ? { adminNote: rr.note } : {}) } },
    { new: true },
  ).lean();
  if (!r) return (await QuestionReport.exists({ _id: reportId })) ? fail(409, 'ADMIN_REPORT_STATE', 'Only open reports can be escalated.') : fail(404, 'ADMIN_REPORT_NOT_FOUND', 'Report not found.');
  await syncTargetModeration(r);
  await adminAudit(admin, 'QUESTION_REPORT_ESCALATED', 'QUESTION_REPORT', r._id, { reason: rr.reason, note: rr.note, req });
  return ok({ report: { id: String(r._id), status: r.status, escalated: true } });
}

// ── Content actions ────────────────────────────────────────────────────────────

async function hideQuestion(admin, id, body = {}, req = null) {
  if (!isId(id)) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  const rr = readReason(body); if (rr.error) return rr.error;
  const q = await Question.findById(id).lean();
  if (!q) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  if (q.status === 'DELETED') return fail(409, 'ADMIN_CONTENT_STATE', 'This question was deleted by its author.');
  if (q.status === 'HIDDEN') return ok({ alreadyHidden: true });
  const now = new Date();
  const done = await Question.findOneAndUpdate({ _id: q._id, status: q.status },
    { $set: { status: 'HIDDEN', statusBeforeHide: q.status, hiddenAt: now, hiddenBy: admin._id, hiddenReason: rr.reason, moderationState: 'REVIEWED' } }, { new: true }).lean();
  if (!done) return fail(409, 'ADMIN_CONTENT_STATE', 'The question changed; please reload.');
  await QuestionAuditLog.create({ event: 'QUESTION_HIDDEN_BY_ADMIN', actorId: admin._id, questionId: q._id, targetUserId: q.askerId });
  await adminAudit(admin, 'QUESTION_HIDDEN', 'QUESTION', q._id, { reason: rr.reason, note: rr.note, details: { previousStatus: q.status }, req });
  return ok({ question: { id: String(q._id), status: 'HIDDEN' } });
}

async function restoreQuestion(admin, id, body = {}, req = null) {
  if (!isId(id)) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  const rr = readReason(body); if (rr.error) return rr.error;
  const q = await Question.findById(id).lean();
  if (!q) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  if (q.status !== 'HIDDEN') return fail(409, 'ADMIN_CONTENT_STATE', 'Only a hidden question can be restored.');
  const back = q.statusBeforeHide && q.statusBeforeHide !== 'HIDDEN' ? q.statusBeforeHide : 'CLOSED';
  await Question.updateOne({ _id: q._id, status: 'HIDDEN' }, { $set: { status: back, hiddenAt: null, hiddenBy: null, hiddenReason: null, statusBeforeHide: null, moderationState: 'REVIEWED' } });
  await QuestionAuditLog.create({ event: 'QUESTION_UNHIDDEN_BY_ADMIN', actorId: admin._id, questionId: q._id, targetUserId: q.askerId });
  await adminAudit(admin, 'QUESTION_RESTORED', 'QUESTION', q._id, { reason: rr.reason, note: rr.note, details: { restoredTo: back }, req });
  return ok({ question: { id: String(q._id), status: effectiveStatus({ ...q, status: back }) } });
}

async function closeQuestion(admin, id, body = {}, req = null) {
  if (!isId(id)) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  const rr = readReason(body); if (rr.error) return rr.error;
  const now = new Date();
  const done = await Question.findOneAndUpdate({ _id: id, status: 'ACTIVE', expiresAt: { $gt: now } }, { $set: { status: 'CLOSED', closedAt: now } }, { new: true }).lean();
  if (!done) return (await Question.exists({ _id: id })) ? fail(409, 'ADMIN_CONTENT_STATE', 'Only an active question can be closed.') : fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  await adminAudit(admin, 'QUESTION_CLOSED', 'QUESTION', done._id, { reason: rr.reason, note: rr.note, req });
  return ok({ question: { id: String(done._id), status: 'CLOSED' } });
}

async function deleteQuestion(admin, id, body = {}, req = null) {
  if (!isId(id)) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  const rr = readReason(body); if (rr.error) return rr.error;
  const q = await Question.findById(id).lean();
  if (!q) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  if (q.status === 'DELETED') return ok({ alreadyDeleted: true });
  await Question.updateOne({ _id: q._id, status: { $ne: 'DELETED' } }, { $set: { status: 'DELETED', deletedAt: new Date(), statusBeforeDelete: effectiveStatus(q), moderationState: 'REVIEWED' } });
  await adminAudit(admin, 'QUESTION_DELETED', 'QUESTION', q._id, { reason: rr.reason, note: rr.note, details: { previousStatus: effectiveStatus(q), soft: true }, req });
  return ok({ question: { id: String(q._id), status: 'DELETED' } });
}

async function markQuestionReviewed(admin, id, body = {}, req = null) {
  if (!isId(id)) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  const rr = readReason(body, { required: false }); if (rr.error) return rr.error;
  const q = await Question.findOneAndUpdate({ _id: id }, { $set: { moderationState: 'REVIEWED' } }, { new: true }).lean();
  if (!q) return fail(404, 'QUESTION_NOT_FOUND', 'Question not found.');
  await adminAudit(admin, 'QUESTION_REVIEWED', 'QUESTION', q._id, { reason: rr.reason, note: rr.note, req });
  return ok({ question: { id: String(q._id), moderationState: 'REVIEWED' } });
}

async function hideAnswer(admin, answerId, body = {}, req = null) {
  if (!isId(answerId)) return fail(404, 'ANSWER_NOT_FOUND', 'Answer not found.');
  const rr = readReason(body); if (rr.error) return rr.error;
  const a = await QuestionAnswer.findOneAndUpdate({ _id: answerId, status: 'ACTIVE' },
    { $set: { status: 'HIDDEN', hiddenAt: new Date(), hiddenBy: admin._id, moderationState: 'REVIEWED' } }, { new: true }).lean();
  if (!a) return (await QuestionAnswer.exists({ _id: answerId })) ? fail(409, 'ADMIN_CONTENT_STATE', 'Only a visible answer can be hidden.') : fail(404, 'ANSWER_NOT_FOUND', 'Answer not found.');
  await Question.updateOne({ _id: a.questionId, answerCount: { $gt: 0 } }, { $inc: { answerCount: -1 } });
  await adminAudit(admin, 'QUESTION_ANSWER_HIDDEN', 'QUESTION_ANSWER', a._id, { reason: rr.reason, note: rr.note, details: { questionId: String(a.questionId) }, req });
  return ok({ answer: { id: String(a._id), status: 'HIDDEN' } });
}

async function restoreAnswer(admin, answerId, body = {}, req = null) {
  if (!isId(answerId)) return fail(404, 'ANSWER_NOT_FOUND', 'Answer not found.');
  const rr = readReason(body); if (rr.error) return rr.error;
  let a;
  try {
    a = await QuestionAnswer.findOneAndUpdate({ _id: answerId, status: 'HIDDEN' },
      { $set: { status: 'ACTIVE', hiddenAt: null, hiddenBy: null, moderationState: 'REVIEWED' } }, { new: true }).lean();
  } catch (err) {
    if (err && err.code === 11000) return fail(409, 'ADMIN_CONTENT_STATE', 'This person has since posted another answer to the question.');
    throw err;
  }
  if (!a) return (await QuestionAnswer.exists({ _id: answerId })) ? fail(409, 'ADMIN_CONTENT_STATE', 'Only a hidden answer can be restored.') : fail(404, 'ANSWER_NOT_FOUND', 'Answer not found.');
  await Question.updateOne({ _id: a.questionId }, { $inc: { answerCount: 1 } });
  await adminAudit(admin, 'QUESTION_ANSWER_RESTORED', 'QUESTION_ANSWER', a._id, { reason: rr.reason, note: rr.note, details: { questionId: String(a.questionId) }, req });
  return ok({ answer: { id: String(a._id), status: 'ACTIVE' } });
}

// ── Question-creation-only restrictions (admin) ────────────────────────────────

async function listRestrictions(query = {}) {
  const now = new Date();
  const filter = query.state === 'all' ? {} : { $or: [{ final: true }, { restrictedUntil: { $gt: now } }] };
  const limit = intIn(query.limit, 1, 100, 25);
  const page = intIn(query.page, 1, 400, 1);
  const [rows, total] = await Promise.all([QuestionRestriction.find(filter).sort({ lastAppliedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), QuestionRestriction.countDocuments(filter)]);
  const people = await peopleById(rows.map(r => r.userId));
  return ok({
    restrictions: rows.map(r => {
      const active = r.final || (r.restrictedUntil && new Date(r.restrictedUntil) > now);
      const last = r.history && r.history.length ? r.history[r.history.length - 1] : null;
      return { userId: String(r.userId), user: personOf(people.get(String(r.userId))), level: r.level, final: !!r.final, active: !!active,
        reason: r.restrictionReason, startedAt: iso(r.lastAppliedAt), endsAt: r.final ? null : iso(r.restrictedUntil),
        appliedBy: last && last.action === 'APPLIED' ? (last.by === 'SYSTEM' ? 'SYSTEM' : 'ADMIN') : null };
    }),
    page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)),
  });
}

/** An admin sets a level (1–5) or takes the next step. Level 5 = final; needs MANAGE_FINAL_RESTRICTIONS. */
async function applyRestriction(admin, userId, body = {}, req = null) {
  if (!isId(userId)) return fail(404, 'ADMIN_USER_NOT_FOUND', 'User not found.');
  const rr = readReason(body); if (rr.error) return rr.error;
  if (!(await User.exists({ _id: userId }))) return fail(404, 'ADMIN_USER_NOT_FOUND', 'User not found.');
  const cur = await QuestionRestriction.findOne({ userId }).lean();
  let level;
  if (body.level === 'NEXT' || body.level === undefined) level = Math.min((cur ? cur.level : 0) + 1, R.RESTRICTION_FINAL_LEVEL);
  else {
    level = Number(body.level);
    if (!Number.isInteger(level) || level < 1 || level > R.RESTRICTION_FINAL_LEVEL) return fail(400, 'ADMIN_INVALID_LEVEL', 'Level must be 1–5 or NEXT.');
  }
  const final = level >= R.RESTRICTION_FINAL_LEVEL;
  if (final && !can(admin, PERMS.MANAGE_FINAL_RESTRICTIONS)) {
    return fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a super admin can apply the final restriction.', { permission: PERMS.MANAGE_FINAL_RESTRICTIONS });
  }
  const now = new Date();
  const until = final ? null : new Date(now.getTime() + R.RESTRICTION_STEPS_MS[level - 1]);
  await QuestionRestriction.updateOne({ userId }, {
    $set: { level, restrictedUntil: until, final, restrictionReason: `ADMIN: ${rr.reason}`.slice(0, 100), lastAppliedAt: now },
    $push: { history: { $each: [{ action: 'APPLIED', level, reason: rr.reason.slice(0, 100), until, final, by: String(admin._id), note: rr.note ? rr.note.slice(0, 300) : null, at: now }], $slice: -50 } },
    $setOnInsert: { userId: oid(userId) },
  }, { upsert: true });
  await QuestionAuditLog.create({ event: 'QUESTION_RESTRICTION_APPLIED', actorId: admin._id, targetUserId: oid(userId), meta: { level, final, by: 'ADMIN' } });
  await adminAudit(admin, 'QUESTION_RESTRICTION_APPLIED', 'USER', userId, { reason: rr.reason, note: rr.note, details: { level, final, until: iso(until), scope: 'QUESTION_CREATION_ONLY' }, req });
  return ok({ restriction: { level, final, endsAt: iso(until) } });
}

/** Lift (keep the level) or reset (back to 0). Lifting a final one, or resetting, needs MANAGE_FINAL_RESTRICTIONS. */
async function removeRestriction(admin, userId, body = {}, req = null) {
  if (!isId(userId)) return fail(404, 'ADMIN_USER_NOT_FOUND', 'User not found.');
  const rr = readReason(body); if (rr.error) return rr.error;
  const reset = body.reset === true;
  const r = await QuestionRestriction.findOne({ userId }).lean();
  if (!r) return fail(404, 'QUESTION_RESTRICTION_NOT_FOUND', 'No question restriction for this user.');
  if ((r.final || reset) && !can(admin, PERMS.MANAGE_FINAL_RESTRICTIONS)) {
    return fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a super admin can lift a final restriction or reset the ladder.', { permission: PERMS.MANAGE_FINAL_RESTRICTIONS });
  }
  const now = new Date();
  await QuestionRestriction.updateOne({ _id: r._id }, {
    $set: { restrictedUntil: null, final: false, ...(reset ? { level: 0 } : {}) },
    $push: { history: { $each: [{ action: reset ? 'RESET' : 'LIFTED', level: reset ? 0 : r.level, reason: rr.reason.slice(0, 100), by: String(admin._id), note: rr.note ? rr.note.slice(0, 300) : null, at: now }], $slice: -50 } },
  });
  await QuestionAuditLog.create({ event: 'QUESTION_RESTRICTION_LIFTED', actorId: admin._id, targetUserId: r.userId, meta: { reset } });
  await adminAudit(admin, 'QUESTION_RESTRICTION_REMOVED', 'USER', userId, { reason: rr.reason, note: rr.note, details: { reset, previousLevel: r.level, wasFinal: !!r.final }, req });
  return ok({ lifted: true, reset });
}

// ── Moderation queue and false-positive review ─────────────────────────────────

async function listModeration(query = {}) {
  const tab = ['rejected', 'flagged_questions', 'flagged_answers'].includes(query.tab) ? query.tab : 'rejected';
  const limit = intIn(query.limit, 1, 100, 25);
  const page = intIn(query.page, 1, 400, 1);
  if (tab === 'rejected') {
    const and = [];
    const status = str(query.status) || 'PENDING_REVIEW';
    if (status !== 'ALL') { if (!QuestionModerationRecord.STATUSES.includes(status)) return fail(400, 'ADMIN_INVALID_FILTER', 'Unknown status.'); and.push({ status }); }
    const ct = str(query.contentType); if (ct) { if (!['QUESTION', 'ANSWER', 'REPLY'].includes(ct)) return fail(400, 'ADMIN_INVALID_FILTER', 'Unknown content type.'); and.push({ contentType: ct }); }
    const sev = str(query.severity); if (sev) { if (!['LOW', 'MEDIUM', 'HIGH'].includes(sev)) return fail(400, 'ADMIN_INVALID_FILTER', 'Unknown severity.'); and.push({ severity: sev }); }
    const filter = and.length ? { $and: and } : {};
    const [rows, total] = await Promise.all([QuestionModerationRecord.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-locationGrid').lean(), QuestionModerationRecord.countDocuments(filter)]);
    const people = await peopleById(rows.map(r => r.userId));
    return ok({ tab, items: rows.map(r => ({ id: String(r._id), kind: 'RECORD', contentType: r.contentType, contentPreview: preview(r.text), user: personOf(people.get(String(r.userId))),
      category: r.category, reasonCode: r.reasonCode, severity: r.severity, verdict: r.verdict, createdAt: iso(r.createdAt), reports: 0, status: r.status,
      restrictionApplied: r.restrictionApplied && r.restrictionApplied.level ? r.restrictionApplied.level : null })), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  }
  const M = tab === 'flagged_questions' ? Question : QuestionAnswer;
  const filter = { moderationState: { $in: ['FLAGGED', 'UNDER_REVIEW'] } };
  const [rows, total] = await Promise.all([M.find(filter).sort({ reportCount: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-normalizedText -clientRequestId -locationGrid').lean(), M.countDocuments(filter)]);
  const people = await peopleById(rows.map(r => r.askerId || r.authorId));
  const cats = tab === 'flagged_answers' ? new Map((await Question.find({ _id: { $in: rows.map(r => r.questionId) } }).select('category').lean()).map(q => [String(q._id), q.category])) : null;
  return ok({ tab, items: rows.map(r => ({ id: String(r._id), kind: tab === 'flagged_questions' ? 'QUESTION' : 'ANSWER', contentType: tab === 'flagged_questions' ? 'QUESTION' : 'ANSWER',
    contentPreview: preview(r.text), user: personOf(people.get(String(r.askerId || r.authorId))), category: r.category || (cats && cats.get(String(r.questionId))) || null,
    reasonCode: 'REPORTED', severity: (r.reportCount || 0) >= 3 ? 'HIGH' : (r.reportCount || 0) >= 2 ? 'MEDIUM' : 'LOW', createdAt: iso(r.createdAt), reports: r.reportCount || 0,
    status: r.moderationState, questionId: r.questionId ? String(r.questionId) : String(r._id) })), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
}

async function moderationRecordDetail(recordId) {
  if (!isId(recordId)) return fail(404, 'ADMIN_RECORD_NOT_FOUND', 'Record not found.');
  const r = await QuestionModerationRecord.findById(recordId).select('-locationGrid').lean();
  if (!r) return fail(404, 'ADMIN_RECORD_NOT_FOUND', 'Record not found.');
  const [people, q, restriction] = await Promise.all([
    peopleById([r.userId, r.reviewedBy]),
    r.questionId ? Question.findById(r.questionId).select('text status expiresAt category').lean() : null,
    restrictionSummary(r.userId),
  ]);
  return ok({
    record: { id: String(r._id), contentType: r.contentType, text: r.text, category: r.category, tags: r.tags || [], verdict: r.verdict, reasonCode: r.reasonCode, severity: r.severity,
      status: r.status, createdAt: iso(r.createdAt), reviewedAt: iso(r.reviewedAt), reviewedBy: r.reviewedBy ? personOf(people.get(String(r.reviewedBy))).name : null,
      adminReason: r.adminReason, adminNote: r.adminNote, restrictionApplied: r.restrictionApplied && r.restrictionApplied.level ? { level: r.restrictionApplied.level, until: iso(r.restrictionApplied.until), final: !!r.restrictionApplied.final } : null,
      restoredContentId: r.restoredContentId ? String(r.restoredContentId) : null },
    user: personOf(people.get(String(r.userId))),
    context: q ? { questionId: String(q._id), questionPreview: preview(q.text), questionStatus: effectiveStatus(q) } : null,
    restriction,
  });
}

/**
 * CONFIRM: the automated decision stands. OVERTURN: a false positive — the content is
 * published as written (a question with a fresh 24 h, an answer/reply if its question is
 * still open), and the restriction step this rejection caused can be undone.
 */
async function decideModerationRecord(admin, recordId, body = {}, req = null) {
  if (!isId(recordId)) return fail(404, 'ADMIN_RECORD_NOT_FOUND', 'Record not found.');
  const decision = str(body.decision);
  if (!['CONFIRM', 'OVERTURN'].includes(decision)) return fail(400, 'ADMIN_INVALID_DECISION', 'Decision must be CONFIRM or OVERTURN.');
  const rr = readReason(body); if (rr.error) return rr.error;
  const now = new Date();
  const claimed = await QuestionModerationRecord.findOneAndUpdate({ _id: recordId, status: 'PENDING_REVIEW' },
    { $set: { status: decision === 'CONFIRM' ? 'CONFIRMED' : 'OVERTURNED', reviewedBy: admin._id, reviewedAt: now, adminReason: rr.reason, adminNote: rr.note } }, { new: true }).lean();
  if (!claimed) return (await QuestionModerationRecord.exists({ _id: recordId })) ? fail(409, 'ADMIN_RECORD_STATE', 'This item was already reviewed.') : fail(404, 'ADMIN_RECORD_NOT_FOUND', 'Record not found.');

  if (decision === 'CONFIRM') {
    await adminAudit(admin, 'QUESTION_MODERATION_CONFIRMED', 'QUESTION_MODERATION', claimed._id, { reason: rr.reason, note: rr.note, details: { contentType: claimed.contentType, reasonCode: claimed.reasonCode }, req });
    return ok({ record: { id: String(claimed._id), status: 'CONFIRMED' } });
  }

  // OVERTURN: publish the content, when that is still possible.
  let restoredId = null, restoreNote = null;
  if (claimed.contentType === 'QUESTION') {
    if (claimed.locationGrid && Array.isArray(claimed.locationGrid.coordinates) && claimed.locationGrid.coordinates.length === 2) {
      const q = await Question.create({ askerId: claimed.userId, category: claimed.category || 'OTHER', text: claimed.text, tags: claimed.tags || [], status: 'ACTIVE',
        locationGrid: { type: 'Point', coordinates: claimed.locationGrid.coordinates }, expiresAt: new Date(now.getTime() + R.LIMITS.QUESTION_TTL_MS),
        restoredFromRecordId: claimed._id, moderationState: 'REVIEWED' });
      restoredId = q._id;
    } else restoreNote = 'NO_LOCATION';
  } else if (claimed.contentType === 'ANSWER') {
    const q = claimed.questionId ? await Question.findById(claimed.questionId).lean() : null;
    if (!q || effectiveStatus(q) !== 'ACTIVE') restoreNote = 'QUESTION_NOT_OPEN';
    else if (await QuestionAnswer.exists({ questionId: q._id, authorId: claimed.userId, status: 'ACTIVE' })) restoreNote = 'ALREADY_ANSWERED';
    else {
      const a = await QuestionAnswer.create({ questionId: q._id, authorId: claimed.userId, text: claimed.text, restoredFromRecordId: claimed._id, moderationState: 'REVIEWED' });
      await Question.updateOne({ _id: q._id }, { $inc: { answerCount: 1 } });
      const first = await QuestionAnswer.findOne({ questionId: q._id }).sort({ createdAt: 1 }).select('createdAt').lean();
      const at = first ? new Date(first.createdAt) : now;   // an earlier answer, if any, stays the first
      await Question.updateOne({ _id: q._id, firstAnswerAt: null }, { $set: { firstAnswerAt: at, timeToFirstAnswerMs: Math.max(0, at - new Date(q.createdAt)) } });
      restoredId = a._id;
    }
  } else if (claimed.contentType === 'REPLY') {
    const q = claimed.questionId ? await Question.findById(claimed.questionId).lean() : null;
    const a = claimed.answerId ? await QuestionAnswer.findById(claimed.answerId).lean() : null;
    if (!q || effectiveStatus(q) !== 'ACTIVE' || !a || a.status !== 'ACTIVE') restoreNote = 'THREAD_NOT_OPEN';
    else {
      const rp = await QuestionReply.create({ questionId: q._id, answerId: a._id, authorId: claimed.userId, text: claimed.text });
      await QuestionAnswer.updateOne({ _id: a._id }, { $inc: { replyCount: 1 } });
      restoredId = rp._id;
    }
  }
  if (restoredId) await QuestionModerationRecord.updateOne({ _id: claimed._id }, { $set: { restoredContentId: restoredId } });

  // Undo the restriction step this rejection caused, if asked.
  let restrictionUndone = false;
  if (body.undoRestriction === true && claimed.restrictionApplied && claimed.restrictionApplied.level) {
    const r = await QuestionRestriction.findOne({ userId: claimed.userId }).lean();
    if (r && (!r.final || can(admin, PERMS.MANAGE_FINAL_RESTRICTIONS))) {
      const newLevel = Math.max(0, r.level - 1);
      await QuestionRestriction.updateOne({ _id: r._id }, {
        $set: { level: newLevel, restrictedUntil: null, final: false },
        $push: { history: { $each: [{ action: 'LIFTED', level: newLevel, reason: 'False positive (admin review)', by: String(admin._id), note: rr.note ? rr.note.slice(0, 300) : null, at: now }], $slice: -50 } },
      });
      await adminAudit(admin, 'QUESTION_RESTRICTION_REMOVED', 'USER', claimed.userId, { reason: rr.reason, note: rr.note, details: { falsePositive: true, recordId: String(claimed._id), newLevel }, req });
      restrictionUndone = true;
    }
  }
  await adminAudit(admin, 'QUESTION_MODERATION_OVERTURNED', 'QUESTION_MODERATION', claimed._id, {
    reason: rr.reason, note: rr.note, details: { contentType: claimed.contentType, reasonCode: claimed.reasonCode, restored: !!restoredId, restoreNote, restrictionUndone }, req });
  return ok({ record: { id: String(claimed._id), status: 'OVERTURNED' }, restored: !!restoredId, restoredContentId: restoredId ? String(restoredId) : null, restoreNote, restrictionUndone });
}

// ── Recent activity ────────────────────────────────────────────────────────────

const FEED_EVENTS = ['QUESTION_CREATED', 'ANSWER_CREATED', 'QUESTION_REPORT_CREATED', 'QUESTION_MODERATION_REJECTED', 'ANSWER_REJECTED', 'REPLY_REJECTED',
  'QUESTION_HIDDEN_BY_ADMIN', 'QUESTION_CLOSED', 'QUESTION_RESTRICTION_APPLIED', 'QUESTION_RESTRICTION_LIFTED', 'QUESTION_DELETED'];
const ADMIN_ACTIONS = ['QUESTION_REVIEWED', 'QUESTION_HIDDEN', 'QUESTION_RESTORED', 'QUESTION_CLOSED', 'QUESTION_DELETED', 'QUESTION_ANSWER_HIDDEN', 'QUESTION_ANSWER_RESTORED',
  'QUESTION_REPORT_UNDER_REVIEW', 'QUESTION_REPORT_RESOLVED', 'QUESTION_REPORT_DISMISSED', 'QUESTION_REPORT_ESCALATED', 'QUESTION_MODERATION_CONFIRMED',
  'QUESTION_MODERATION_OVERTURNED', 'QUESTION_RESTRICTION_APPLIED', 'QUESTION_RESTRICTION_REMOVED', 'QUESTION_DATA_EXPORTED'];

async function recentActivity(query = {}) {
  const limit = intIn(query.limit, 1, 100, 30);
  const [sys, adm] = await Promise.all([
    QuestionAuditLog.find({ event: { $in: FEED_EVENTS } }).sort({ createdAt: -1 }).limit(limit).lean(),
    AuditLog.find({ action: { $in: ADMIN_ACTIONS } }).sort({ timestamp: -1 }).limit(limit).select('actorId action targetType targetId reason timestamp').lean(),
  ]);
  const people = await peopleById([...sys.map(e => e.actorId), ...adm.map(e => e.actorId)]);
  const items = [
    ...sys.map(e => {
      const tt = e.meta && e.meta.targetType;
      const type = e.event === 'QUESTION_REPORT_CREATED' ? (tt === 'ANSWER' ? 'ANSWER_REPORTED' : tt === 'REPLY' ? 'REPLY_REPORTED' : 'QUESTION_REPORTED') : e.event;
      return { source: 'SYSTEM', type, at: iso(e.createdAt), actor: e.actorId ? personOf(people.get(String(e.actorId))).name : 'System',
        questionId: e.questionId ? String(e.questionId) : null, answerId: e.answerId ? String(e.answerId) : null, userId: e.targetUserId ? String(e.targetUserId) : null,
        detail: e.meta && (e.meta.reason || e.meta.level) ? { reason: e.meta.reason || null, level: e.meta.level || null } : null };
    }),
    ...adm.map(e => ({ source: 'ADMIN', type: e.action, at: iso(e.timestamp), actor: personOf(people.get(String(e.actorId))).name, targetType: e.targetType, targetId: e.targetId ? String(e.targetId) : null, reason: e.reason || null })),
  ].sort((x, y) => new Date(y.at) - new Date(x.at)).slice(0, limit);
  return ok({ items });
}

// ── Export (CSV; no coordinates, no personal data, no moderation internals) ────

const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;                // spreadsheet formula injection
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

async function exportQuestionsCsv(admin, query = {}, req = null) {
  const f = await buildQuestionFilter(query);
  if (f.error) return f.error;
  const rows = await Question.find(f.filter).sort(f.sort).limit(10000)
    .select('category status expiresAt createdAt answerCount reportCount moderationState timeToFirstAnswerMs').lean();
  const now = Date.now();
  const header = ['questionId', 'category', 'status', 'createdAt', 'answerCount', 'reportCount', 'moderationState', 'firstAnswerMinutes', 'locationBand'];
  const lines = [header.join(',')].concat(rows.map(q => [
    String(q._id), q.category, effectiveStatus(q, now), iso(q.createdAt), q.answerCount || 0, q.reportCount || 0, q.moderationState || 'ALLOWED',
    q.timeToFirstAnswerMs == null ? '' : Math.round(q.timeToFirstAnswerMs / 60000), 'LOCAL_10KM',
  ].map(csvCell).join(',')));
  await adminAudit(admin, 'QUESTION_DATA_EXPORTED', 'SYSTEM', null, { reason: 'CSV export', details: { rows: rows.length, filters: Object.keys(query).filter(k => k !== 'page' && k !== 'limit') }, req });
  return { success: true, status: 200, csv: lines.join('\n'), rows: rows.length };
}

module.exports = {
  stats, listQuestions, questionDetail, userHistory,
  listReports, reportDetail, setReportStatus, escalateReport,
  hideQuestion, restoreQuestion, closeQuestion, deleteQuestion, markQuestionReviewed, hideAnswer, restoreAnswer,
  listRestrictions, applyRestriction, removeRestriction,
  listModeration, moderationRecordDetail, decideModerationRecord,
  recentActivity, exportQuestionsCsv,
  _internal: { computeStats, periodOf, istDayStart, readReason, csvCell, buildQuestionFilter },
};
