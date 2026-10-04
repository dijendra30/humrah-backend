// services/questionService.js
// -----------------------------------------------------------------------------
// Ask a Question — Phase 2 backend (spec: ASK_A_QUESTION_PHASE_1_PRODUCT_SPEC.md).
//
// Every function takes the authenticated user (req.user, from the existing authenticate
// middleware) and returns { success, status, ... } or fail(status, code, message), the
// convention Sports uses. Nothing the app sends is trusted for identity, ownership,
// eligibility, location, restriction, expiry, block or moderation state.
//
// KILL SWITCH: QUESTIONS_ENABLED (default off) — every user-facing function refuses with
// QUESTIONS_DISABLED while it is off. The expiry tick still runs (it only closes things).
//
// PRIVACY: a question stores only a ~1 km grid-cell centre (never the exact point); clients
// get a coarse distance band and never coordinates or a distance number.
//
// ENFORCEMENT: automated moderation only refuses content. The one consequence it can have
// is a QUESTION-CREATION-ONLY restriction (1 h → 1 d → 2 d → 4 d → final/admin). It never
// touches account status, suspensionInfo or strikes; reports never act on anyone by
// themselves. Account-level action is for admins, through the existing admin tools.
//
// LOGS: ids and codes only — never question/answer text, never coordinates.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const Question = require('../models/Question');
const QuestionAnswer = require('../models/QuestionAnswer');
const QuestionReply = require('../models/QuestionReply');
const QuestionReport = require('../models/QuestionReport');
const QuestionHide = require('../models/QuestionHide');
const QuestionRestriction = require('../models/QuestionRestriction');
const QuestionAuditLog = require('../models/QuestionAuditLog');
const User = require('../models/User');
const redis = require('./redisService');
const cm = require('./contentModeration');
const R = require('./questions/questionRules');

const { ObjectId } = mongoose.Types;
const { LIMITS } = R;

// ── Small helpers ──────────────────────────────────────────────────────────────

const fail = (status, code, message, extra = {}) => ({ success: false, status, code, message, ...extra });
const isId = v => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const same = (a, b) => String(a) === String(b);
const disabled = () => fail(404, 'QUESTIONS_DISABLED', 'Questions are not available right now.');
const notFound = () => fail(404, 'QUESTION_NOT_FOUND', 'This question is not available.');
const deletedGone = () => fail(410, 'QUESTION_DELETED', 'This question is no longer available.');
const log = (tag, fields) => console.log(`[QUESTIONS] ${tag} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`);

async function audit(event, { actorId = null, questionId = null, answerId = null, targetUserId = null, meta = null } = {}) {
  try { await QuestionAuditLog.create({ event, actorId, questionId, answerId, targetUserId, meta }); }
  catch (err) { console.error('[QUESTIONS] audit failed:', event, err && err.name); }
}

const publicUser = u => (u ? {
  id: String(u._id),
  firstName: u.firstName || 'Someone',
  profilePhoto: u.profilePhoto || null,
  verified: !!(u.verified === true || u.photoVerificationStatus === 'approved'),
} : { id: null, firstName: 'Former member', profilePhoto: null, verified: false });
const PUBLIC_FIELDS = 'firstName profilePhoto verified photoVerificationStatus status';

/** ACTIVE past its expiry is EXPIRED everywhere, before the cron flips it. */
const effectiveStatus = (q, now = Date.now()) => (q.status === 'ACTIVE' && new Date(q.expiresAt).getTime() <= now ? 'EXPIRED' : q.status);

// ── Location (privacy) ─────────────────────────────────────────────────────────

const validLngLat = (lng, lat) => Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lng === 0 && lat === 0);

/** The user's live position if fixed within maxAgeMs, as [lng, lat]; else null. Never returned to clients. */
function freshPoint(user, maxAgeMs, now = Date.now()) {
  const ll = user && user.liveLocation;
  if (!ll || !ll.updatedAt || now - new Date(ll.updatedAt).getTime() > maxAgeMs) return null;
  const c = Array.isArray(ll.coordinates) ? ll.coordinates.map(Number) : [];
  if (validLngLat(c[0], c[1])) return [c[0], c[1]];
  if (validLngLat(Number(ll.lng), Number(ll.lat))) return [Number(ll.lng), Number(ll.lat)];
  return null;
}

/** The centre of the ~1 km grid cell containing the point. The exact point is never stored. */
function snapToGrid([lng, lat]) {
  const latStep = LIMITS.GRID_KM / 111.32;
  const cLat = Math.max(-89.99, Math.min(89.99, (Math.floor(lat / latStep) + 0.5) * latStep));
  const lngStep = LIMITS.GRID_KM / (111.32 * Math.cos((cLat * Math.PI) / 180));
  let cLng = (Math.floor(lng / lngStep) + 0.5) * lngStep;
  if (cLng > 180) cLng -= 360; if (cLng < -180) cLng += 360;
  return [Number(cLng.toFixed(6)), Number(cLat.toFixed(6))];
}

function metersBetween([lng1, lat1], [lng2, lat2]) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const bandFor = (viewerPoint, q) => (viewerPoint && q.locationGrid && Array.isArray(q.locationGrid.coordinates) ? R.bandOf(metersBetween(viewerPoint, q.locationGrid.coordinates)) : null);
const bandOut = b => (b ? { key: b.key, label: b.label } : null);

// ── Blocks (the existing system: User.blockedUsers, both directions) ───────────

async function blockedIds(user) {
  const mine = (user.blockedUsers || []).filter(id => mongoose.isValidObjectId(id)).map(id => String(id));
  const theirs = await User.find({ blockedUsers: user._id }).select('_id').lean();
  return [...new Set([...mine, ...theirs.map(t => String(t._id))])];
}
async function isBlockedPair(user, otherId) {
  if (!otherId || same(otherId, user._id)) return false;
  if ((user.blockedUsers || []).some(id => same(id, otherId))) return true;
  return !!(await User.exists({ _id: otherId, blockedUsers: user._id }));
}

// ── Rate limits (the existing Redis window counters; fail open like Sports) ─────

const isNewAccount = (user, now) => user.createdAt && now - new Date(user.createdAt).getTime() < LIMITS.NEW_ACCOUNT_MS;

async function burstCheck(user) {
  const uid = String(user._id);
  try {
    if (await redis.get(`ratelimit:questions:cooldown:${uid}`)) {
      return fail(429, 'QUESTION_RATE_LIMITED', 'You’re going a bit fast. Please wait a minute and try again.', { retryAfterSeconds: R.BURST.cooldownSeconds });
    }
    const n = await redis.incrementWithWindow(`ratelimit:questions:burst:${uid}`, R.BURST.windowSeconds);
    if (n > R.BURST.max) {
      await redis.set(`ratelimit:questions:cooldown:${uid}`, 1, R.BURST.cooldownSeconds);
      return fail(429, 'QUESTION_RATE_LIMITED', 'You’re going a bit fast. Please wait a minute and try again.', { retryAfterSeconds: R.BURST.cooldownSeconds });
    }
  } catch (err) {
    console.error('[QUESTIONS] burst limit failed open:', err && err.name);
  }
  return null;
}

/** Consumes one unit of `action` (question | answer | reply) in every window; refuses past the limit. */
async function quotaCheck(user, action, now) {
  const half = isNewAccount(user, now);
  for (const [win, max] of R.RATE[action]) {
    const limit = half ? Math.max(1, Math.floor(max / 2)) : max;
    try {
      const n = await redis.incrementWithWindow(`ratelimit:questions:${action}:${win}:${user._id}`, win);
      if (n > limit) {
        const what = action === 'question' ? 'questions' : action === 'answer' ? 'answers' : 'replies';
        return fail(429, 'QUESTION_RATE_LIMITED', `You’ve posted a lot of ${what} for now. Please try again later.`, { retryAfterSeconds: win });
      }
    } catch (err) {
      console.error(`[QUESTIONS] ${action} limit failed open:`, err && err.name);
    }
  }
  return null;
}

// ── Question-creation-only restriction ─────────────────────────────────────────

/** The current restriction for question creation, or null. */
async function activeRestriction(userId, now = Date.now()) {
  const r = await QuestionRestriction.findOne({ userId }).lean();
  if (!r) return null;
  if (r.final) return r;
  if (r.restrictedUntil && new Date(r.restrictedUntil).getTime() > now) return r;
  return null;
}
const restrictedFail = r => fail(403, 'QUESTION_RESTRICTED', r.final
  ? 'You can’t post new questions right now. You can still answer and use the rest of Humrah.'
  : 'You can’t post new questions for a while. You can still answer and use the rest of Humrah.',
{ restrictedUntil: r.final ? null : new Date(r.restrictedUntil).toISOString(), final: !!r.final });

/**
 * One step up the ladder: 1 h → 1 d → 2 d → 4 d → final (admin-controlled). Atomic on the
 * level counter, so two rejections at once still climb exactly two steps. Never touches the
 * User document (status, suspensionInfo, strikes).
 */
async function applyQuestionRestriction(userId, reason, now = new Date()) {
  const bumped = await QuestionRestriction.findOneAndUpdate(
    { userId },
    { $inc: { level: 1 }, $setOnInsert: { userId } },
    { upsert: true, new: true },
  ).lean();
  const level = bumped.level;
  const final = level >= R.RESTRICTION_FINAL_LEVEL;
  const until = final ? null : new Date(now.getTime() + R.RESTRICTION_STEPS_MS[level - 1]);
  await QuestionRestriction.updateOne({ _id: bumped._id }, {
    $set: { restrictedUntil: until, final, restrictionReason: reason, lastAppliedAt: now },
    $push: { history: { $each: [{ action: 'APPLIED', level, reason, until, final, by: 'SYSTEM', at: now }], $slice: -50 } },
  });
  await audit('QUESTION_RESTRICTION_APPLIED', { targetUserId: userId, meta: { level, final, reason } });
  log('RESTRICTION_APPLIED', { user: userId, level, final });
  return { level, final, until };
}

// ── Text and input validation ──────────────────────────────────────────────────

/** Lowercased, punctuation/emoji-free form for duplicate detection. */
const normalizeForDuplicate = t => cm.fold(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function similarity(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Sanitised text and its length checks; a fail() on error. */
function checkText(raw, { min, max, minLetters = 0, what }) {
  if (typeof raw !== 'string') return { error: fail(400, `${what}_INVALID`, 'Please write your text.') };
  if (raw.length > LIMITS.RAW_INPUT_MAX) return { error: fail(400, `${what}_TOO_LONG`, `Please keep it under ${max} characters.`) };
  const text = cm.sanitizeText(raw);
  const len = cm.graphemeLength(text);
  if (len === 0) return { error: fail(400, `${what}_EMPTY`, 'Please write something first.') };
  if (len > max) return { error: fail(400, `${what}_TOO_LONG`, `Please keep it under ${max} characters.`) };
  if (len < min || cm.letterCount(text) < minLetters) {
    return { error: fail(400, `${what}_TOO_SHORT`, min > 1 ? `Please write at least ${min} characters.` : 'Please write something first.') };
  }
  return { text, length: len };
}

/** Tags: predefined keys only (case/space-insensitive), at most 3, deduplicated. */
function checkTags(raw, category) {
  if (raw === undefined || raw === null) return { tags: [] };
  if (!Array.isArray(raw)) return { error: fail(400, 'QUESTION_INVALID_TAGS', 'Please choose from the suggested tags.') };
  if (raw.length > 10) return { error: fail(400, 'QUESTION_TOO_MANY_TAGS', `Please choose up to ${LIMITS.MAX_TAGS} tags.`) };
  const allowed = new Set(R.tagsFor(category));
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string' || t.length > 40) return { error: fail(400, 'QUESTION_INVALID_TAGS', 'Please choose from the suggested tags.') };
    const key = t.trim().toUpperCase().replace(/[\s/-]+/g, '_');
    if (!allowed.has(key)) return { error: fail(400, 'QUESTION_INVALID_TAGS', 'Please choose from the suggested tags.') };
    if (!out.includes(key)) out.push(key);
  }
  if (out.length > LIMITS.MAX_TAGS) return { error: fail(400, 'QUESTION_TOO_MANY_TAGS', `Please choose up to ${LIMITS.MAX_TAGS} tags.`) };
  return { tags: out };
}

function idempotencyKeyOf(headerKey, bodyKey) {
  const k = headerKey !== undefined ? headerKey : bodyKey;
  if (k === undefined || k === null || k === '') return { key: null };
  if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(k)) return { error: fail(400, 'QUESTION_INVALID_REQUEST_ID', 'Invalid request id.') };
  return { key: k };
}

// ── Views ──────────────────────────────────────────────────────────────────────

function questionView(q, { viewer, asker, band = null, viewerHasAnswered = false, now = Date.now() }) {
  const status = effectiveStatus(q, now);
  const isOwner = same(q.askerId, viewer._id);
  return {
    id: String(q._id),
    category: q.category,
    categoryLabel: R.CATEGORY_LABELS[q.category] || q.category,
    text: q.text,
    tags: (q.tags || []).map(k => ({ key: k, label: R.TAG_LABELS[k] || k })),
    status,
    acceptingAnswers: status === 'ACTIVE',
    createdAt: new Date(q.createdAt).toISOString(),
    expiresAt: new Date(q.expiresAt).toISOString(),
    closedAt: q.closedAt ? new Date(q.closedAt).toISOString() : null,
    answerCount: q.answerCount || 0,
    asker: publicUser(asker),
    isOwner,
    distanceBand: isOwner ? null : bandOut(band),      // never coordinates or a distance number
    visibility: 'AROUND_YOU',
    viewerHasAnswered: !!viewerHasAnswered,
  };
}

/** The rules every reader of one question goes through. Returns { q } or { error }. */
async function loadVisible(user, questionId) {
  if (!isId(questionId)) return { error: notFound() };
  const q = await Question.findById(questionId).lean();
  if (!q) return { error: notFound() };
  const isOwner = same(q.askerId, user._id);
  if (q.status === 'DELETED') return { error: deletedGone() };
  if (q.status === 'HIDDEN' && !isOwner) return { error: notFound() };
  if (!isOwner && await isBlockedPair(user, q.askerId)) return { error: notFound() };      // a block is not revealed
  if (!isOwner) {
    const asker = await User.findById(q.askerId).select('status').lean();
    if (!asker || asker.status !== 'ACTIVE') return { error: notFound() };
  }
  return { q, isOwner };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** GET /api/questions/config — what the app needs to draw the composer. Works with the switch off. */
function getConfig() {
  return {
    success: true, status: 200,
    enabled: R.questionsEnabled(),
    categories: R.CATEGORIES.map(k => ({ key: k, label: R.CATEGORY_LABELS[k], tags: R.tagsFor(k).map(t => ({ key: t, label: R.TAG_LABELS[t] })) })),
    limits: {
      questionMinChars: LIMITS.QUESTION_MIN_CHARS, questionMaxChars: LIMITS.QUESTION_MAX_CHARS, maxTags: LIMITS.MAX_TAGS,
      answerMaxChars: LIMITS.ANSWER_MAX_CHARS, replyMaxChars: LIMITS.REPLY_MAX_CHARS, homeMax: LIMITS.HOME_MAX,
    },
  };
}

/** POST /api/questions */
async function createQuestion(user, body = {}, { idempotencyKey } = {}) {
  if (!R.questionsEnabled()) return disabled();
  const now = Date.now();
  const idem = idempotencyKeyOf(idempotencyKey, body.clientRequestId);
  if (idem.error) return idem.error;

  // A retry of a request that already succeeded returns the same question.
  if (idem.key) {
    const prior = await Question.findOne({ askerId: user._id, clientRequestId: idem.key }).lean();
    if (prior) return { success: true, status: 200, replayed: true, question: questionView(prior, { viewer: user, asker: user, now }) };
  }

  const restriction = await activeRestriction(user._id, now);
  if (restriction) return restrictedFail(restriction);

  if (typeof body.category !== 'string' || !R.CATEGORIES.includes(body.category)) {
    return fail(400, 'QUESTION_INVALID_CATEGORY', 'Please pick a topic.');
  }
  const t = checkText(body.text, { min: LIMITS.QUESTION_MIN_CHARS, max: LIMITS.QUESTION_MAX_CHARS, minLetters: LIMITS.QUESTION_MIN_LETTERS, what: 'QUESTION' });
  if (t.error) return t.error;
  const tg = checkTags(body.tags, body.category);
  if (tg.error) return tg.error;

  const point = freshPoint(user, LIMITS.ASKER_FRESH_MS, now);
  if (!point) return fail(409, 'QUESTION_LOCATION_REQUIRED', 'Turn on location so people nearby can see your question.');

  const burst = await burstCheck(user);
  if (burst) return burst;

  // Server moderation — the decision. Tags are predefined keys, so only the text needs it.
  const mod = await cm.moderateUserText(t.text, { context: 'question' });
  if (mod.verdict !== 'SAFE') {
    let restrictionApplied = null;
    if (mod.verdict === 'BLOCKED' && mod.abusive) restrictionApplied = await applyQuestionRestriction(user._id, mod.reasonCode);
    await audit('QUESTION_MODERATION_REJECTED', { actorId: user._id, meta: { verdict: mod.verdict, reason: mod.reasonCode } });
    log('MODERATION_REJECTED', { user: user._id, verdict: mod.verdict, reason: mod.reasonCode });
    return fail(422, 'QUESTION_MODERATION_REJECTED', mod.userMessage, {
      moderation: { verdict: mod.verdict, rephrase: mod.verdict === 'REVIEW' },
      ...(restrictionApplied ? { restrictedUntil: restrictionApplied.final ? null : restrictionApplied.until.toISOString() } : {}),
    });
  }

  // The same question again within 24 h (similarity ≥ 0.90): refused, nothing else happens.
  const norm = normalizeForDuplicate(t.text);
  const recent = await Question.find({ askerId: user._id, createdAt: { $gte: new Date(now - LIMITS.DUPLICATE_WINDOW_MS) } })
    .select('+normalizedText').sort({ createdAt: -1 }).limit(20).lean();
  if (recent.some(r => r.normalizedText && similarity(r.normalizedText, norm) >= LIMITS.DUPLICATE_THRESHOLD)) {
    return fail(409, 'QUESTION_DUPLICATE', 'You asked this recently. Your earlier question is still open.');
  }

  const active = await Question.countDocuments({ askerId: user._id, status: 'ACTIVE', expiresAt: { $gt: new Date(now) } });
  if (active >= LIMITS.MAX_ACTIVE_PER_USER) {
    return fail(409, 'QUESTION_LIMIT_REACHED', `You can have ${LIMITS.MAX_ACTIVE_PER_USER} open questions at a time. Close one to ask another.`);
  }

  const quota = await quotaCheck(user, 'question', now);
  if (quota) return quota;

  let q;
  try {
    q = await Question.create({
      askerId: user._id,
      category: body.category,
      text: t.text,
      tags: tg.tags,
      status: 'ACTIVE',
      locationGrid: { type: 'Point', coordinates: snapToGrid(point) },
      expiresAt: new Date(now + LIMITS.QUESTION_TTL_MS),
      clientRequestId: idem.key || undefined,
      normalizedText: norm,
    });
  } catch (err) {
    if (err && err.code === 11000 && idem.key) {          // the same request raced itself: return the winner
      const prior = await Question.findOne({ askerId: user._id, clientRequestId: idem.key }).lean();
      if (prior) return { success: true, status: 200, replayed: true, question: questionView(prior, { viewer: user, asker: user, now }) };
    }
    throw err;
  }
  await audit('QUESTION_CREATED', { actorId: user._id, questionId: q._id, meta: { category: q.category, tags: q.tags.length } });
  log('CREATED', { question: q._id, user: user._id });
  return { success: true, status: 201, question: questionView(q.toObject(), { viewer: user, asker: user, now }) };
}

/**
 * GET /api/questions/nearby?home=1 | ?page=&limit=
 * The viewer's own open questions first (they count toward the limit), then nearby ones
 * (within 10 km of a fresh viewer location), ranked: viewer has not answered yet → closer
 * band → category the viewer is into → fewer answers → newer. Bounded: the nearest
 * DISCOVERY_CANDIDATES only; one query each for askers, answers and hides (no N+1).
 */
async function nearbyQuestions(user, query = {}) {
  if (!R.questionsEnabled()) return disabled();
  const now = Date.now();
  const point = freshPoint(user, LIMITS.VIEWER_FRESH_MS, now);
  if (!point) return fail(409, 'QUESTION_LOCATION_REQUIRED', 'Turn on location to see questions near you.');

  const home = query.home === '1' || query.home === 'true' || query.home === true;
  const limit = home ? LIMITS.HOME_MAX : Math.min(Math.max(parseInt(query.limit, 10) || LIMITS.PAGE_MAX, 1), LIMITS.PAGE_MAX);
  const page = home ? 1 : Math.min(Math.max(parseInt(query.page, 10) || 1, 1), 50);

  const blocked = await blockedIds(user);
  const hidden = (await QuestionHide.find({ userId: user._id }).sort({ createdAt: -1 }).limit(1000).select('questionId').lean()).map(h => h.questionId);
  const notBlocked = [...blocked.map(id => new ObjectId(id)), user._id];

  const [own, candidates] = await Promise.all([
    Question.find({ askerId: user._id, status: 'ACTIVE', expiresAt: { $gt: new Date(now) } }).sort({ createdAt: -1 }).limit(LIMITS.MAX_ACTIVE_PER_USER).lean(),
    Question.aggregate([
      { $geoNear: {
        near: { type: 'Point', coordinates: point },
        key: 'locationGrid',
        distanceField: '_m',
        maxDistance: LIMITS.RADIUS_M,
        spherical: true,
        query: { status: 'ACTIVE', expiresAt: { $gt: new Date(now) }, askerId: { $nin: notBlocked }, _id: { $nin: hidden } },
      } },
      { $limit: LIMITS.DISCOVERY_CANDIDATES },
      { $project: { normalizedText: 0, clientRequestId: 0 } },
    ]),
  ]);

  const askerIds = [...new Set(candidates.map(c => String(c.askerId)))];
  const [askers, myAnswers] = await Promise.all([
    askerIds.length ? User.find({ _id: { $in: askerIds } }).select(PUBLIC_FIELDS).lean() : [],
    candidates.length ? QuestionAnswer.find({ questionId: { $in: candidates.map(c => c._id) }, authorId: user._id, status: 'ACTIVE' }).select('questionId').lean() : [],
  ]);
  const askerById = new Map(askers.filter(a => a.status === 'ACTIVE').map(a => [String(a._id), a]));
  const answered = new Set(myAnswers.map(a => String(a.questionId)));
  const interests = ((user.questionnaire && user.questionnaire.interests) || []).map(s => String(s).toLowerCase());
  const likes = cat => (R.CATEGORY_INTEREST_WORDS[cat] || []).some(w => interests.some(i => i.includes(w)));

  const ranked = candidates
    .filter(c => askerById.has(String(c.askerId)))
    .map(c => ({ c, band: R.bandOf(c._m), answered: answered.has(String(c._id)), liked: likes(c.category) }))
    .sort((a, b) => (a.answered - b.answered)
      || (a.band.index - b.band.index)
      || (b.liked - a.liked)
      || ((a.c.answerCount || 0) - (b.c.answerCount || 0))
      || (new Date(b.c.createdAt) - new Date(a.c.createdAt)));

  const ownViews = own.map(q => questionView(q, { viewer: user, asker: user, now }));
  const othersViews = ranked.map(r => questionView(r.c, { viewer: user, asker: askerById.get(String(r.c.askerId)), band: r.band, viewerHasAnswered: r.answered, now }));
  const all = [...ownViews, ...othersViews];
  const start = (page - 1) * limit;
  const slice = all.slice(start, start + limit);
  return { success: true, status: 200, questions: slice, page, limit, hasMore: !home && all.length > start + limit };
}

/** GET /api/questions/:questionId */
async function getQuestion(user, questionId) {
  if (!R.questionsEnabled()) return disabled();
  const v = await loadVisible(user, questionId);
  if (v.error) return v.error;
  const { q, isOwner } = v;
  const now = Date.now();
  const [asker, mine] = await Promise.all([
    isOwner ? user : User.findById(q.askerId).select(PUBLIC_FIELDS).lean(),
    isOwner ? null : QuestionAnswer.exists({ questionId: q._id, authorId: user._id, status: 'ACTIVE' }),
  ]);
  const band = isOwner ? null : bandFor(freshPoint(user, LIMITS.VIEWER_FRESH_MS, now), q);
  const view = questionView(q, { viewer: user, asker, band, viewerHasAnswered: !!mine, now });
  return { success: true, status: 200, question: view };
}

/** The owner's own question, for close / delete. Non-owners get 404 (no IDOR signal). */
async function loadOwned(user, questionId) {
  if (!isId(questionId)) return { error: notFound() };
  const q = await Question.findOne({ _id: questionId, askerId: user._id }).lean();
  if (!q) return { error: notFound() };
  return { q };
}

/** POST /api/questions/:questionId/close — ACTIVE → CLOSED, owner only; repeat-safe. */
async function closeQuestion(user, questionId) {
  if (!R.questionsEnabled()) return disabled();
  const o = await loadOwned(user, questionId);
  if (o.error) return o.error;
  const now = new Date();
  const status = effectiveStatus(o.q, now.getTime());
  if (status === 'CLOSED') return { success: true, status: 200, alreadyClosed: true, question: questionView(o.q, { viewer: user, asker: user }) };
  if (status === 'DELETED') return deletedGone();
  if (status === 'EXPIRED') return fail(409, 'QUESTION_EXPIRED', 'This question has already closed.');
  if (status === 'HIDDEN') return fail(409, 'QUESTION_CLOSED', 'This question is closed.');
  const done = await Question.findOneAndUpdate(
    { _id: o.q._id, askerId: user._id, status: 'ACTIVE', expiresAt: { $gt: now } },
    { $set: { status: 'CLOSED', closedAt: now } },
    { new: true },
  ).lean();
  if (!done) return closeQuestion(user, questionId);       // raced with expiry / another close: re-read once
  await audit('QUESTION_CLOSED', { actorId: user._id, questionId: done._id });
  log('CLOSED', { question: done._id });
  return { success: true, status: 200, question: questionView(done, { viewer: user, asker: user }) };
}

/** DELETE /api/questions/:questionId — soft delete, owner only; repeat-safe. Nothing is destroyed. */
async function deleteQuestion(user, questionId) {
  if (!R.questionsEnabled()) return disabled();
  const o = await loadOwned(user, questionId);
  if (o.error) return o.error;
  if (o.q.status === 'DELETED') return { success: true, status: 200, alreadyDeleted: true };
  const now = new Date();
  const done = await Question.findOneAndUpdate(
    { _id: o.q._id, askerId: user._id, status: { $ne: 'DELETED' } },
    { $set: { status: 'DELETED', deletedAt: now, statusBeforeDelete: effectiveStatus(o.q, now.getTime()) } },
    { new: true },
  ).lean();
  if (done) {
    await audit('QUESTION_DELETED', { actorId: user._id, questionId: done._id });
    log('DELETED', { question: done._id });
  }
  return { success: true, status: 200, deleted: true };
}

/** Why a question takes no new answers / replies right now, or null. */
function writeRefusal(q, now = Date.now()) {
  const s = effectiveStatus(q, now);
  if (s === 'ACTIVE') return null;
  if (s === 'EXPIRED') return fail(409, 'QUESTION_EXPIRED', 'This question is no longer accepting answers.');
  if (s === 'CLOSED') return fail(409, 'QUESTION_CLOSED', 'This question is closed.');
  if (s === 'DELETED') return deletedGone();
  return notFound();
}

/** POST /api/questions/:questionId/answers */
async function createAnswer(user, questionId, body = {}) {
  if (!R.questionsEnabled()) return disabled();
  const v = await loadVisible(user, questionId);
  if (v.error) return v.error;
  const { q, isOwner } = v;
  const now = Date.now();
  const refusal = writeRefusal(q, now);
  if (refusal) return refusal;
  if (isOwner) return fail(403, 'ANSWER_OWN_QUESTION', 'You can reply to answers on your own question, not answer it.');

  // Only people near it can answer (fresh location, within 10 km of the question's grid cell).
  const point = freshPoint(user, LIMITS.VIEWER_FRESH_MS, now);
  if (!point) return fail(409, 'QUESTION_LOCATION_REQUIRED', 'Turn on location to answer questions near you.');
  if (metersBetween(point, q.locationGrid.coordinates) > LIMITS.RADIUS_M) {
    return fail(403, 'QUESTION_OUT_OF_RANGE', 'This question is for people nearby.');
  }

  const t = checkText(body.text, { min: LIMITS.ANSWER_MIN_CHARS, max: LIMITS.ANSWER_MAX_CHARS, what: 'ANSWER' });
  if (t.error) return t.error;

  const burst = await burstCheck(user);
  if (burst) return burst;

  const mod = await cm.moderateUserText(t.text, { context: 'answer' });
  if (mod.verdict !== 'SAFE') {
    await audit('ANSWER_REJECTED', { actorId: user._id, questionId: q._id, meta: { verdict: mod.verdict, reason: mod.reasonCode } });
    log('ANSWER_REJECTED', { question: q._id, user: user._id, verdict: mod.verdict, reason: mod.reasonCode });
    return fail(422, 'QUESTION_MODERATION_REJECTED', mod.userMessage, { moderation: { verdict: mod.verdict, rephrase: mod.verdict === 'REVIEW' } });
  }

  if (await QuestionAnswer.exists({ questionId: q._id, authorId: user._id, status: 'ACTIVE' })) {
    return fail(409, 'ANSWER_ALREADY_EXISTS', 'You’ve already answered this question.');
  }

  const quota = await quotaCheck(user, 'answer', now);
  if (quota) return quota;

  // Take a slot: still ACTIVE, not expired, under 50 — one atomic update.
  const slot = await Question.findOneAndUpdate(
    { _id: q._id, status: 'ACTIVE', expiresAt: { $gt: new Date(now) }, answerCount: { $lt: LIMITS.MAX_ANSWERS } },
    { $inc: { answerCount: 1 } },
    { new: true },
  ).lean();
  if (!slot) {
    const fresh = await Question.findById(q._id).lean();
    return writeRefusal(fresh, Date.now()) || fail(409, 'ANSWER_LIMIT_REACHED', 'This question has plenty of answers already.');
  }
  let a;
  try {
    a = await QuestionAnswer.create({ questionId: q._id, authorId: user._id, text: t.text });
  } catch (err) {
    await Question.updateOne({ _id: q._id, answerCount: { $gt: 0 } }, { $inc: { answerCount: -1 } });   // give the slot back
    if (err && err.code === 11000) return fail(409, 'ANSWER_ALREADY_EXISTS', 'You’ve already answered this question.');
    throw err;
  }
  await audit('ANSWER_CREATED', { actorId: user._id, questionId: q._id, answerId: a._id, targetUserId: q.askerId });
  log('ANSWER_CREATED', { question: q._id, answer: a._id });
  return { success: true, status: 201, answer: answerView(a.toObject(), { viewer: user, author: user, question: q }), answerCount: slot.answerCount };
}

function answerView(a, { viewer, author, question, replies = [] }) {
  return {
    id: String(a._id),
    questionId: String(a.questionId),
    text: a.text,
    createdAt: new Date(a.createdAt).toISOString(),
    author: publicUser(author),
    isMine: same(a.authorId, viewer._id),
    canReply: effectiveStatus(question) === 'ACTIVE' && (same(question.askerId, viewer._id) || same(a.authorId, viewer._id)),
    replyCount: a.replyCount || 0,
    replies,
  };
}
function replyView(r, { viewer, author }) {
  return { id: String(r._id), answerId: String(r.answerId), text: r.text, createdAt: new Date(r.createdAt).toISOString(), author: publicUser(author), isMine: same(r.authorId, viewer._id) };
}

/**
 * GET /api/questions/:questionId/answers?after=<answerId>&limit=
 * Oldest first; people in a block pair with the viewer, accounts no longer active, and
 * content the viewer reported are left out. Replies come inline (one level).
 */
async function listAnswers(user, questionId, query = {}) {
  if (!R.questionsEnabled()) return disabled();
  const v = await loadVisible(user, questionId);
  if (v.error) return v.error;
  const { q } = v;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || LIMITS.MAX_ANSWERS, 1), LIMITS.MAX_ANSWERS);
  const blocked = await blockedIds(user);
  const filter = { questionId: q._id, status: 'ACTIVE', authorId: { $nin: blocked.map(id => new ObjectId(id)) } };
  if (query.after !== undefined) {
    if (!isId(String(query.after))) return fail(400, 'QUESTION_INVALID_CURSOR', 'Invalid cursor.');
    const cursor = await QuestionAnswer.findOne({ _id: String(query.after), questionId: q._id }).select('createdAt').lean();
    if (cursor) filter.$or = [{ createdAt: { $gt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $gt: cursor._id } }];
  }
  const answers = await QuestionAnswer.find(filter).sort({ createdAt: 1, _id: 1 }).limit(limit + 1).lean();
  const page = answers.slice(0, limit);
  const reported = new Set((await QuestionReport.find({ reporterId: user._id, questionId: q._id }).select('targetId').lean()).map(r => String(r.targetId)));
  const visible = page.filter(a => !reported.has(String(a._id)));
  const replies = visible.length ? await QuestionReply.find({ answerId: { $in: visible.map(a => a._id) }, status: 'ACTIVE', authorId: { $nin: blocked.map(id => new ObjectId(id)) } })
    .sort({ createdAt: 1 }).limit(visible.length * LIMITS.MAX_REPLIES).lean() : [];
  const people = [...new Set([...visible.map(a => String(a.authorId)), ...replies.map(r => String(r.authorId))])];
  const users = people.length ? await User.find({ _id: { $in: people } }).select(PUBLIC_FIELDS).lean() : [];
  const byId = new Map(users.filter(u => u.status === 'ACTIVE').map(u => [String(u._id), u]));
  const repliesBy = new Map();
  for (const r of replies) {
    if (reported.has(String(r._id)) || !byId.has(String(r.authorId))) continue;
    const list = repliesBy.get(String(r.answerId)) || [];
    list.push(replyView(r, { viewer: user, author: byId.get(String(r.authorId)) }));
    repliesBy.set(String(r.answerId), list);
  }
  const out = visible.filter(a => byId.has(String(a.authorId)))
    .map(a => answerView(a, { viewer: user, author: byId.get(String(a.authorId)), question: q, replies: repliesBy.get(String(a._id)) || [] }));
  return { success: true, status: 200, answers: out, hasMore: answers.length > limit, nextAfter: answers.length > limit ? String(page[page.length - 1]._id) : null };
}

/** DELETE /api/questions/:questionId/answers/:answerId — the author's soft delete. */
async function deleteAnswer(user, questionId, answerId) {
  if (!R.questionsEnabled()) return disabled();
  if (!isId(questionId) || !isId(answerId)) return notFound();
  const done = await QuestionAnswer.findOneAndUpdate(
    { _id: answerId, questionId, authorId: user._id, status: 'ACTIVE' },
    { $set: { status: 'DELETED', deletedAt: new Date() } },
    { new: true },
  ).lean();
  if (!done) {
    const mine = await QuestionAnswer.exists({ _id: answerId, questionId, authorId: user._id });
    return mine ? { success: true, status: 200, alreadyDeleted: true } : notFound();
  }
  await Question.updateOne({ _id: questionId, answerCount: { $gt: 0 } }, { $inc: { answerCount: -1 } });
  await audit('ANSWER_DELETED', { actorId: user._id, questionId, answerId: done._id });
  return { success: true, status: 200, deleted: true };
}

/** POST /api/questions/:questionId/answers/:answerId/replies — one level; the asker or that answer's author. */
async function createReply(user, questionId, answerId, body = {}) {
  if (!R.questionsEnabled()) return disabled();
  const v = await loadVisible(user, questionId);
  if (v.error) return v.error;
  const { q, isOwner } = v;
  const now = Date.now();
  const refusal = writeRefusal(q, now);
  if (refusal) return refusal;
  if (!isId(answerId)) return fail(404, 'ANSWER_NOT_FOUND', 'This answer is not available.');
  const a = await QuestionAnswer.findOne({ _id: answerId, questionId: q._id, status: 'ACTIVE' }).lean();
  if (!a) return fail(404, 'ANSWER_NOT_FOUND', 'This answer is not available.');
  const isAnswerAuthor = same(a.authorId, user._id);
  if (!isOwner && !isAnswerAuthor) return fail(403, 'REPLY_NOT_ALLOWED', 'Only the person who asked and the person who answered can reply here.');
  // The other side of this little thread: blocked either way → as if it did not exist.
  const other = isOwner ? a.authorId : q.askerId;
  if (!same(other, user._id) && await isBlockedPair(user, other)) return fail(404, 'ANSWER_NOT_FOUND', 'This answer is not available.');

  const t = checkText(body.text, { min: LIMITS.REPLY_MIN_CHARS, max: LIMITS.REPLY_MAX_CHARS, what: 'REPLY' });
  if (t.error) return t.error;
  const burst = await burstCheck(user);
  if (burst) return burst;
  const mod = await cm.moderateUserText(t.text, { context: 'reply' });
  if (mod.verdict !== 'SAFE') {
    await audit('REPLY_REJECTED', { actorId: user._id, questionId: q._id, answerId: a._id, meta: { verdict: mod.verdict, reason: mod.reasonCode } });
    return fail(422, 'QUESTION_MODERATION_REJECTED', mod.userMessage, { moderation: { verdict: mod.verdict, rephrase: mod.verdict === 'REVIEW' } });
  }
  const quota = await quotaCheck(user, 'reply', now);
  if (quota) return quota;
  const slot = await QuestionAnswer.findOneAndUpdate(
    { _id: a._id, status: 'ACTIVE', replyCount: { $lt: LIMITS.MAX_REPLIES } },
    { $inc: { replyCount: 1 } },
    { new: true },
  ).lean();
  if (!slot) return fail(409, 'REPLY_LIMIT_REACHED', 'This answer has reached its reply limit.');
  const r = await QuestionReply.create({ questionId: q._id, answerId: a._id, authorId: user._id, text: t.text });
  await audit('REPLY_CREATED', { actorId: user._id, questionId: q._id, answerId: a._id });
  return { success: true, status: 201, reply: replyView(r.toObject(), { viewer: user, author: user }) };
}

/** POST /api/questions/:questionId/hide — out of this viewer's discovery only. */
async function hideQuestion(user, questionId) {
  if (!R.questionsEnabled()) return disabled();
  const v = await loadVisible(user, questionId);
  if (v.error) return v.error;
  if (v.isOwner) return fail(400, 'QUESTION_HIDE_OWN', 'You can close or delete your own question instead.');
  await QuestionHide.updateOne({ userId: user._id, questionId: v.q._id }, { $setOnInsert: { userId: user._id, questionId: v.q._id, reason: 'HIDDEN' } }, { upsert: true });
  await audit('QUESTION_HIDDEN', { actorId: user._id, questionId: v.q._id });
  return { success: true, status: 200, hidden: true };
}

/**
 * POST /api/questions/reports { targetType, targetId, reason, description? }
 * Records the report for Safety review and hides the content from the reporter. Repeat-safe.
 * Never acts on the reported person.
 */
async function reportContent(user, body = {}) {
  if (!R.questionsEnabled()) return disabled();
  const { targetType, targetId, reason } = body;
  const description = body.description == null ? '' : body.description;
  if (!['QUESTION', 'ANSWER', 'REPLY'].includes(targetType) || !isId(targetId)) return fail(400, 'QUESTION_INVALID_REPORT', 'Invalid report.');
  if (!QuestionReport.REASONS.includes(reason)) return fail(400, 'QUESTION_INVALID_REPORT', 'Please choose a reason.');
  if (typeof description !== 'string' || description.length > 500) return fail(400, 'QUESTION_INVALID_REPORT', 'Please keep the details under 500 characters.');

  let questionId, reportedUserId;
  if (targetType === 'QUESTION') {
    questionId = targetId;
  } else {
    const M = targetType === 'ANSWER' ? QuestionAnswer : QuestionReply;
    const doc = await M.findById(targetId).select('questionId authorId').lean();
    if (!doc) return notFound();
    questionId = String(doc.questionId); reportedUserId = doc.authorId;
  }
  const v = await loadVisible(user, questionId);
  if (v.error && v.error.code !== 'QUESTION_DELETED') return v.error;
  const q = v.q || await Question.findById(questionId).lean();
  if (!q) return notFound();
  if (targetType === 'QUESTION') reportedUserId = q.askerId;
  if (same(reportedUserId, user._id)) return fail(400, 'QUESTION_INVALID_REPORT', 'You can’t report your own post.');

  let created = true;
  try {
    await QuestionReport.create({ reporterId: user._id, targetType, targetId, questionId: q._id, reportedUserId, reason, description: cm.sanitizeText(description) });
  } catch (err) {
    if (err && err.code === 11000) created = false; else throw err;
  }
  if (targetType === 'QUESTION') {
    await QuestionHide.updateOne({ userId: user._id, questionId: q._id }, { $set: { reason: 'REPORTED' }, $setOnInsert: { userId: user._id, questionId: q._id } }, { upsert: true });
  }
  if (created) {
    await audit('QUESTION_REPORT_CREATED', { actorId: user._id, questionId: q._id, targetUserId: reportedUserId, meta: { targetType, reason } });
    log('REPORT_CREATED', { question: q._id, targetType });
  }
  return { success: true, status: created ? 201 : 200, reported: true, alreadyReported: !created };
}

/** GET /api/questions/mine/restriction — the caller's own question-creation status (for the composer). */
async function myRestriction(user) {
  if (!R.questionsEnabled()) return disabled();
  const r = await activeRestriction(user._id);
  return { success: true, status: 200, restricted: !!r, final: !!(r && r.final), restrictedUntil: r && !r.final ? new Date(r.restrictedUntil).toISOString() : null };
}

// ── Expiry (cron) ──────────────────────────────────────────────────────────────

/**
 * ACTIVE questions past expiresAt → EXPIRED, in bounded batches (indexed on status+expiresAt).
 * Idempotent: the update repeats the condition, so a re-run or a second server changes nothing.
 */
async function tickQuestionExpiry(now = new Date(), { maxBatches = 4 } = {}) {
  let expired = 0, batches = 0;
  for (; batches < maxBatches; batches++) {
    const due = await Question.find({ status: 'ACTIVE', expiresAt: { $lte: now } }).sort({ expiresAt: 1 }).limit(LIMITS.EXPIRY_BATCH).select('_id').lean();
    if (!due.length) break;
    const ids = due.map(d => d._id);
    const r = await Question.updateMany({ _id: { $in: ids }, status: 'ACTIVE', expiresAt: { $lte: now } }, { $set: { status: 'EXPIRED' } });
    expired += r.modifiedCount || 0;
    if ((r.modifiedCount || 0) > 0) {
      try {
        await QuestionAuditLog.insertMany(ids.map(id => ({ event: 'QUESTION_EXPIRED', questionId: id })), { ordered: false });
      } catch (err) { console.error('[QUESTIONS] expiry audit failed:', err && err.name); }
    }
    if (due.length < LIMITS.EXPIRY_BATCH) { batches++; break; }
  }
  if (expired) log('EXPIRED', { count: expired });
  return { expired, batches };
}

// ── Admin (explicit Safety action; audited) ────────────────────────────────────

async function adminLiftRestriction(admin, userId, { note = null, reset = false } = {}) {
  if (!isId(userId)) return fail(400, 'QUESTION_INVALID_USER', 'Invalid user.');
  const now = new Date();
  const r = await QuestionRestriction.findOne({ userId }).lean();
  if (!r) return fail(404, 'QUESTION_RESTRICTION_NOT_FOUND', 'No question restriction for this user.');
  const step = { action: reset ? 'RESET' : 'LIFTED', level: reset ? 0 : r.level, by: String(admin._id), note: typeof note === 'string' ? note.slice(0, 300) : null, at: now };
  await QuestionRestriction.updateOne({ _id: r._id }, {
    $set: { restrictedUntil: null, final: false, ...(reset ? { level: 0 } : {}) },
    $push: { history: { $each: [step], $slice: -50 } },
  });
  await audit('QUESTION_RESTRICTION_LIFTED', { actorId: admin._id, targetUserId: userId, meta: { reset: !!reset } });
  return { success: true, status: 200, lifted: true, reset: !!reset };
}

async function adminGetRestriction(userId) {
  if (!isId(userId)) return fail(400, 'QUESTION_INVALID_USER', 'Invalid user.');
  const r = await QuestionRestriction.findOne({ userId }).lean();
  return { success: true, status: 200, restriction: r ? { level: r.level, restrictedUntil: r.restrictedUntil, final: r.final, reason: r.restrictionReason, history: r.history } : null };
}

async function adminSetHidden(admin, questionId, hide, reason = null) {
  if (!isId(questionId)) return notFound();
  const now = new Date();
  const q = await Question.findById(questionId).lean();
  if (!q || q.status === 'DELETED') return notFound();
  if (hide) {
    if (q.status !== 'HIDDEN') {
      await Question.updateOne({ _id: q._id, status: { $ne: 'DELETED' } }, { $set: { status: 'HIDDEN', hiddenAt: now, hiddenBy: admin._id, hiddenReason: typeof reason === 'string' ? reason.slice(0, 200) : null, statusBeforeDelete: q.status } });
    }
    await audit('QUESTION_HIDDEN_BY_ADMIN', { actorId: admin._id, questionId: q._id, targetUserId: q.askerId });
  } else {
    if (q.status === 'HIDDEN') {
      const back = q.statusBeforeDelete && q.statusBeforeDelete !== 'HIDDEN' ? q.statusBeforeDelete : 'CLOSED';
      await Question.updateOne({ _id: q._id, status: 'HIDDEN' }, { $set: { status: back, hiddenAt: null, hiddenBy: null, hiddenReason: null } });
    }
    await audit('QUESTION_UNHIDDEN_BY_ADMIN', { actorId: admin._id, questionId: q._id, targetUserId: q.askerId });
  }
  return { success: true, status: 200, hidden: !!hide };
}

async function adminListReports(query = {}) {
  const status = ['OPEN', 'REVIEWED', 'ACTIONED', 'DISMISSED'].includes(query.status) ? query.status : 'OPEN';
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
  const rows = await QuestionReport.find({ status }).sort({ createdAt: -1 }).limit(limit).lean();
  return { success: true, status: 200, reports: rows };
}

module.exports = {
  getConfig, createQuestion, nearbyQuestions, getQuestion, closeQuestion, deleteQuestion,
  createAnswer, listAnswers, deleteAnswer, createReply, hideQuestion, reportContent, myRestriction,
  tickQuestionExpiry, adminLiftRestriction, adminGetRestriction, adminSetHidden, adminListReports,
  _internal: { snapToGrid, freshPoint, metersBetween, similarity, normalizeForDuplicate, applyQuestionRestriction, activeRestriction, effectiveStatus, checkTags, checkText },
};
