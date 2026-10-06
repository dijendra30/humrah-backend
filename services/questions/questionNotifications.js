// services/questions/questionNotifications.js
// -----------------------------------------------------------------------------
// Ask a Question — Phase 4 pushes (spec: ASK_A_QUESTION_PHASE_1_PRODUCT_SPEC.md §12).
//
//   QUESTION_ANSWERED  to the asker only, when someone answers their question.
//                      "Someone answered your question" / Asha answered: "Any good café…"
//                      At most one push per question per ANSWER_PUSH_WINDOW_MS; answers that
//                      arrive inside the window wait and the every-minute tick sends them as
//                      one ("3 new answers: …"), or a single one as above.
//   QUESTION_REPLY     in one answer's thread: the asker replies → the answer's author; the
//                      author replies → the asker. Never to the person who wrote it. At most
//                      one per thread, each way, per REPLY_PUSH_WINDOW_MS (no rollup: the
//                      notification already on the phone opens the same thread).
//
// SERVER-AUTHORITATIVE: the recipient is read from the question / answer in the database,
// never from the request. Everything is re-checked when it is sent: the question is not
// deleted or hidden, the answer or reply is still there, the recipient is active, not
// suspended, has pushes and "Question answers" on, neither side blocks the other, and
// only devices that declared supportsQuestions get it.
//
// EXACTLY ONCE: each answer goes null → QUEUED → SENT | SKIPPED through conditional
// updates (QuestionAnswer.ownerPush); each reply is taken once (recipientNotifiedAt). A
// retried or concurrent call can never announce the same answer or reply twice.
//
// NEVER BREAKS THE WRITE: questionService calls dispatch() after the answer / reply is
// saved and does not wait for it; nothing here throws.
//
// PRIVACY: the payload carries ids, a first name and at most 60 characters of the
// QUESTION (never the answer or reply text), and no location, distance, contact or
// moderation detail. Logs: counts and question ids only — no names, user ids or text.
//
// KILL SWITCH: QUESTION_PUSH_ENABLED (default on); nothing is sent while QUESTIONS_ENABLED
// is off either.
// -----------------------------------------------------------------------------
'use strict';

const Question = require('../../models/Question');
const QuestionAnswer = require('../../models/QuestionAnswer');
const QuestionReply = require('../../models/QuestionReply');
const QuestionReport = require('../../models/QuestionReport');
const QuestionAuditLog = require('../../models/QuestionAuditLog');
const User = require('../../models/User');
const R = require('./questionRules');

// Lazy, like Sports: tests and the harness stub it, and firebase loads only when sending.
const fcm = () => require('../../utils/fcmHelper');

const ANSWER_PUSH_WINDOW_MS = 2 * 60 * 1000;
const REPLY_PUSH_WINDOW_MS  = 2 * 60 * 1000;
// A push that failed to send is retried by the tick while it is this fresh…
const PUSH_RETRY_MS = 10 * 60 * 1000;
// …and answers left waiting longer than this (the server was down, the switch was off) are dropped.
const PUSH_STALE_MS = 60 * 60 * 1000;
const PREVIEW_MAX = 60;          // graphemes of the question, "…" included
const NAME_MAX = 30;
const MAX_FLUSH_PER_TICK = 200;

const TYPE_ANSWERED = 'QUESTION_ANSWERED';
const TYPE_REPLY = 'QUESTION_REPLY';
const TITLE_ANSWERED = 'Someone answered your question';
const TITLE_ROLLUP = 'New answers to your question';

const same = (a, b) => a != null && b != null && String(a) === String(b);
const envBool = (v, dflt) => (v === undefined || v === null || String(v).trim() === '' ? dflt : String(v).trim().toLowerCase() !== 'false');
const pushEnabled = () => R.questionsEnabled() && envBool(process.env.QUESTION_PUSH_ENABLED, true);
const log = summary => console.log('[QUESTION_PUSH]', JSON.stringify(summary));

const PUSH_USER_FIELDS = '_id firstName status suspensionInfo notifications.pushNotifications notifications.questionAnswers notifications.replies fcmDevices blockedUsers';
const ACTOR_FIELDS = '_id firstName status suspensionInfo blockedUsers';

// ── Pure helpers (exported for tests) ──────────────────────────────────────────

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = s => (segmenter ? Array.from(segmenter.segment(s), x => x.segment) : Array.from(s));

/** At most [max] graphemes on one line, "…" included when cut. */
function clip(text, max) {
  const line = String(text || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  const g = graphemes(line);
  return g.length <= max ? line : `${g.slice(0, max - 1).join('').trimEnd()}…`;
}

const questionPreview = text => clip(text, PREVIEW_MAX);

/** The first word of the first name only; "Someone" when there is none. */
function firstNameOf(u) {
  const first = clip(String((u && u.firstName) || '').replace(/["“”]/g, ''), NAME_MAX).split(' ')[0];
  return first || 'Someone';
}

function isSuspended(u, now = Date.now()) {
  const s = u && u.suspensionInfo;
  if (!s || s.isSuspended !== true) return false;
  if (s.suspendedUntil && new Date(s.suspendedUntil).getTime() <= now) return false;
  return true;
}

const includesId = (list, id) => (list || []).some(x => same(x, id));
const blockedEitherWay = (a, b) => !!a && !!b && (includesId(a.blockedUsers, b._id) || includesId(b.blockedUsers, a._id));

/** Only devices whose app build declared it can open a Questions push; only real tokens. */
function capableTokens(u) {
  const out = [];
  for (const d of (u && u.fcmDevices) || []) {
    if (d && d.supportsQuestions === true && typeof d.token === 'string' && d.token.trim()) out.push(d.token.trim());
  }
  return [...new Set(out)];
}

/** Someone whose content others can no longer see (lists leave them out): no push about it. */
const actorGone = (u, now) => !u || u.status !== 'ACTIVE' || isSuspended(u, now);

/**
 * Why [u] gets no Questions push, or null. [actor] is who answered / replied (null for a
 * rollup: each answer's author is checked separately). [kind] 'answer' | 'reply'.
 */
function recipientSkip(u, { actor = null, kind = 'answer', now = Date.now() } = {}) {
  if (!u) return 'user_missing';
  if (u.status !== 'ACTIVE') return 'not_active';
  if (isSuspended(u, now)) return 'suspended';
  const n = u.notifications || {};
  if (n.pushNotifications === false) return 'push_disabled';
  if (n.questionAnswers === false) return 'question_answers_disabled';
  if (kind === 'reply' && n.replies === false) return 'replies_disabled';
  if (actor && same(actor._id, u._id)) return 'self';
  if (actor && actorGone(actor, now)) return 'actor_not_active';
  if (actor && blockedEitherWay(u, actor)) return 'blocked';
  if (capableTokens(u).length === 0) return 'no_capable_device';
  return null;
}

const deepLink = (questionId, answerId) => `humrah://questions/${questionId}?answer=${answerId}`;

function answeredPayload({ question, answerId, recipientId, title, body, count }) {
  const qid = String(question._id);
  return {
    type:            TYPE_ANSWERED,
    questionId:      qid,
    answerId:        String(answerId),
    recipientUserId: String(recipientId),
    notificationId:  `question_answered_${qid}`,
    title,
    body,
    answerCount:     String(count),
    deepLink:        deepLink(qid, answerId),
  };
}

/** Asha answered: "Any good café to work from near Kamla Nagar?" */
const singleAnswerBody = (actor, question) => `${firstNameOf(actor)} answered: "${questionPreview(question.text)}"`;
/** 3 new answers: "Any good café to work from near Kamla Nagar?" */
const rollupBody = (count, question) => `${count} new answers: "${questionPreview(question.text)}"`;

function replyPayload({ question, answerId, replyId, recipientId, toAsker, actor }) {
  const qid = String(question._id);
  return {
    type:            TYPE_REPLY,
    questionId:      qid,
    answerId:        String(answerId),
    replyId:         String(replyId),
    recipientUserId: String(recipientId),
    notificationId:  `question_reply_${answerId}`,
    title:           toAsker ? `${firstNameOf(actor)} replied on your question` : `${firstNameOf(actor)} replied to your answer`,
    body:            `On "${questionPreview(question.text)}"`,
    deepLink:        deepLink(qid, answerId),
  };
}

// ── Fire-and-forget, but trackable (tests await settle()) ─────────────────────

const inFlight = new Set();
/** Runs [fn] after the caller's response; never throws into the caller. */
function dispatch(fn) {
  const p = Promise.resolve().then(fn).catch(err => console.error('[QUESTION_PUSH] failed:', err && err.name));
  inFlight.add(p);
  p.finally(() => inFlight.delete(p));
}
async function settle() { while (inFlight.size) await Promise.allSettled([...inFlight]); }

async function audit(event, fields) {
  try { await QuestionAuditLog.create({ event, actorId: null, ...fields }); }
  catch (err) { console.error('[QUESTION_PUSH] audit failed:', err && err.name); }
}

// ── QUESTION_ANSWERED ─────────────────────────────────────────────────────────

/**
 * ONE atomic update on the question decides it: when its window is over and nothing is
 * waiting, it starts a new window (this call sends); otherwise the answer waits for the
 * tick. The question as it was just before says which. Null if the question is gone.
 */
async function claimOrQueue(questionId, now) {
  const at = new Date(now);
  const cutoff = new Date(now - ANSWER_PUSH_WINDOW_MS);
  const quiet = { $and: [
    { $lte: [{ $ifNull: ['$answerPush.pendingCount', 0] }, 0] },
    { $lt: [{ $ifNull: ['$answerPush.lastSentAt', new Date(0)] }, cutoff] },
  ] };
  const before = await Question.findOneAndUpdate(
    { _id: questionId },
    [{ $set: { answerPush: { $cond: [
      quiet,
      { lastSentAt: at, pendingCount: 0, pendingSince: null },
      {
        lastSentAt:   { $ifNull: ['$answerPush.lastSentAt', null] },
        pendingCount: { $add: [{ $ifNull: ['$answerPush.pendingCount', 0] }, 1] },
        pendingSince: { $ifNull: ['$answerPush.pendingSince', at] },
      },
    ] } } }],
    { new: false },
  ).lean();
  if (!before) return null;
  const p = before.answerPush || {};
  const claimed = !(p.pendingCount > 0) && (!p.lastSentAt || new Date(p.lastSentAt).getTime() < cutoff.getTime());
  return { claimed, previous: p };
}

/**
 * A claimed push was not delivered: give the window back and leave the answers waiting,
 * so the tick retries. Undoes only OUR claim: if anything else started a window since,
 * that stands.
 */
function releaseClaim(questionId, claimedAt, previous, retry) {
  return Question.updateOne(
    { _id: questionId, 'answerPush.lastSentAt': claimedAt },
    [{ $set: { answerPush: {
      lastSentAt:   (previous && previous.lastSentAt) || null,
      pendingCount: { $add: [{ $ifNull: ['$answerPush.pendingCount', 0] }, retry.count] },
      pendingSince: { $ifNull: [retry.since, { $ifNull: ['$answerPush.pendingSince', null] }] },
    } } }],
  ).catch(err => console.error('[QUESTION_PUSH] release failed:', err && err.name));
}

const skipAnswers = (ids, at) => (ids.length
  ? QuestionAnswer.updateMany({ _id: { $in: ids }, ownerPush: 'QUEUED' }, { $set: { ownerPush: 'SKIPPED', ownerNotifiedAt: at } })
  : null);

/**
 * After an answer was saved (questionService.createAnswer). The first answer after a quiet
 * spell is pushed to the asker now; later ones wait for the tick. Everything is read fresh
 * from the database by id. Always resolves with a counts-only summary.
 */
async function notifyAnswerCreated(answerId, now = Date.now()) {
  const summary = { event: 'question_answer_push', sent: 0, queued: 0, skipped: {} };
  const skip = r => { summary.skipped[r] = (summary.skipped[r] || 0) + 1; };
  const at = new Date(now);
  try {
    if (!pushEnabled()) { skip('disabled'); return summary; }
    // Take the answer: only the first call for it gets past this.
    const a = await QuestionAnswer.findOneAndUpdate(
      { _id: answerId, ownerPush: null },
      { $set: { ownerPush: 'QUEUED' } },
      { new: true },
    ).lean();
    if (!a) { skip('already_handled'); return summary; }
    const drop = async reason => { skip(reason); await skipAnswers([a._id], at); return summary; };
    summary.questionId = String(a.questionId);
    if (a.status !== 'ACTIVE') return drop('answer_gone');
    const q = await Question.findById(a.questionId).select('askerId text status').lean();
    if (!q) return drop('question_missing');
    if (q.status === 'DELETED' || q.status === 'HIDDEN') return drop('question_gone');
    const users = await User.find({ _id: { $in: [q.askerId, a.authorId] } }).select(PUSH_USER_FIELDS).lean();
    const owner = users.find(u => same(u._id, q.askerId));
    const author = users.find(u => same(u._id, a.authorId));
    // Never the owner's own answer: recipientSkip refuses actor === recipient ('self').
    const reason = recipientSkip(owner, { actor: author || null, kind: 'answer', now });
    if (reason) return drop(reason);
    if (!author) return drop('actor_not_active');

    const claim = await claimOrQueue(q._id, now);
    if (!claim) return drop('question_missing');
    if (!claim.claimed) { summary.queued++; return summary; }   // the tick sends it (it stays QUEUED)
    // Ours to send now — unless the tick already took it (only if a send outlived a window).
    const mine = await QuestionAnswer.updateOne({ _id: a._id, ownerPush: 'QUEUED' }, { $set: { ownerPush: 'SENT', ownerNotifiedAt: at } });
    if (!mine.modifiedCount) { skip('taken_by_tick'); return summary; }
    const payload = answeredPayload({ question: q, answerId: a._id, recipientId: owner._id, title: TITLE_ANSWERED, body: singleAnswerBody(author, q), count: 1 });
    const tokens = capableTokens(owner);
    const res = await fcm().sendDataFcm(owner._id, tokens, payload, { quietLog: true });
    if (res && res.delivered) {
      summary.sent++;
      await audit('QUESTION_ANSWER_NOTIFIED', { questionId: q._id, answerId: a._id, targetUserId: owner._id, meta: { kind: 'single', count: 1, devices: tokens.length } });
      return summary;
    }
    skip('fcm_failed');
    // Back to waiting, and the window back, so the tick retries it.
    await QuestionAnswer.updateOne({ _id: a._id, ownerPush: 'SENT' }, { $set: { ownerPush: 'QUEUED', ownerNotifiedAt: null } });
    await releaseClaim(q._id, at, claim.previous, { count: 1, since: at });
  } catch (err) {
    summary.error = err && err.name;
    console.error('[QUESTION_PUSH] answer push failed:', err && err.name);
  } finally {
    log(summary);
  }
  return summary;
}

/**
 * One question's waiting answers. The claim (nothing waiting, a new window) is one
 * conditional update, so of two ticks, or two servers, exactly one gets past it. Each
 * answer is then taken QUEUED → SENT one by one, and everything is decided from the
 * database NOW: the question, the asker, and which of the answers are still there and
 * by someone the asker can see.
 */
async function flushOne(row, now, summary) {
  const skip = r => { summary.skipped[r] = (summary.skipped[r] || 0) + 1; };
  const at = new Date(now);
  const cutoff = new Date(now - ANSWER_PUSH_WINDOW_MS);
  const before = await Question.findOneAndUpdate(
    { _id: row._id, 'answerPush.pendingCount': { $gt: 0 }, $or: [{ 'answerPush.lastSentAt': null }, { 'answerPush.lastSentAt': { $lt: cutoff } }] },
    { $set: { 'answerPush.lastSentAt': at, 'answerPush.pendingCount': 0, 'answerPush.pendingSince': null } },
    { new: false },
  ).select('askerId text status answerPush').lean();
  if (!before) { skip('claimed_elsewhere'); return; }
  const waiting = before.answerPush || {};
  const since = waiting.pendingSince ? new Date(waiting.pendingSince).getTime() : now;

  // Take every waiting answer of this question (at most 50 exist).
  const queued = await QuestionAnswer.find({ questionId: before._id, ownerPush: 'QUEUED' }).sort({ createdAt: 1, _id: 1 }).select('_id').lean();
  const taken = [];
  for (const x of queued) {
    const t = await QuestionAnswer.findOneAndUpdate({ _id: x._id, ownerPush: 'QUEUED' }, { $set: { ownerPush: 'SENT', ownerNotifiedAt: at } }, { new: true })
      .select('_id authorId status createdAt').lean();
    if (t) taken.push(t);
  }
  const giveUp = async reason => { skip(reason); await QuestionAnswer.updateMany({ _id: { $in: taken.map(t => t._id) } }, { $set: { ownerPush: 'SKIPPED' } }); };
  if (taken.length === 0) { skip('nothing_waiting'); return; }
  if (now - since > PUSH_STALE_MS) return giveUp('stale');
  if (before.status === 'DELETED' || before.status === 'HIDDEN') return giveUp('question_gone');

  const owner = await User.findById(before.askerId).select(PUSH_USER_FIELDS).lean();
  const reason = recipientSkip(owner, { actor: null, kind: 'answer', now });
  if (reason) return giveUp(reason);

  const authors = await User.find({ _id: { $in: taken.map(t => t.authorId) } }).select(ACTOR_FIELDS).lean();
  const byId = new Map(authors.map(u => [String(u._id), u]));
  const reported = new Set((await QuestionReport.find({ reporterId: owner._id, questionId: before._id }).select('targetId').lean()).map(r => String(r.targetId)));
  const visible = taken.filter(t => {
    const au = byId.get(String(t.authorId));
    return t.status === 'ACTIVE' && !actorGone(au, now) && !same(au._id, owner._id) && !blockedEitherWay(owner, au) && !reported.has(String(t._id));
  });
  const hidden = taken.filter(t => !visible.includes(t)).map(t => t._id);
  if (hidden.length) await QuestionAnswer.updateMany({ _id: { $in: hidden } }, { $set: { ownerPush: 'SKIPPED' } });
  if (visible.length === 0) { skip('nothing_visible'); return; }

  const first = visible[0];
  const single = visible.length === 1;
  const payload = answeredPayload({
    question: before, answerId: first._id, recipientId: owner._id,
    title: single ? TITLE_ANSWERED : TITLE_ROLLUP,
    body: single ? singleAnswerBody(byId.get(String(first.authorId)), before) : rollupBody(visible.length, before),
    count: visible.length,
  });
  const tokens = capableTokens(owner);
  const res = await fcm().sendDataFcm(owner._id, tokens, payload, { quietLog: true });
  if (res && res.delivered) {
    summary.sent++;
    await audit('QUESTION_ANSWER_NOTIFIED', { questionId: before._id, answerId: first._id, targetUserId: owner._id, meta: { kind: single ? 'single' : 'rollup', count: visible.length, devices: tokens.length } });
    return;
  }
  skip('fcm_failed');
  const ids = visible.map(t => t._id);
  if (now - since <= PUSH_RETRY_MS) {
    await QuestionAnswer.updateMany({ _id: { $in: ids }, ownerPush: 'SENT' }, { $set: { ownerPush: 'QUEUED', ownerNotifiedAt: null } });
    await releaseClaim(before._id, at, waiting, { count: ids.length, since: new Date(since) });
  } else {
    await QuestionAnswer.updateMany({ _id: { $in: ids } }, { $set: { ownerPush: 'SKIPPED' } });
  }
}

/**
 * The every-minute step (cronJobs.js): questions whose window is over with answers still
 * waiting. One query on the partial index; each question is claimed before anything is
 * sent. [now] is injectable for tests.
 */
async function flushAnswerPushes(now = Date.now()) {
  const summary = { event: 'question_answer_flush', due: 0, sent: 0, skipped: {} };
  if (!pushEnabled()) return summary;
  const cutoff = new Date(now - ANSWER_PUSH_WINDOW_MS);
  const due = await Question.find({
    'answerPush.pendingCount': { $gt: 0 },
    $or: [{ 'answerPush.lastSentAt': null }, { 'answerPush.lastSentAt': { $lt: cutoff } }],
  }).limit(MAX_FLUSH_PER_TICK).select('_id').lean();
  summary.due = due.length;
  for (const row of due) {
    try { await flushOne(row, now, summary); }
    catch (err) { console.error('[QUESTION_PUSH] flush failed:', err && err.name); }
  }
  if (summary.due > 0) log(summary);
  return summary;
}

// ── QUESTION_REPLY ────────────────────────────────────────────────────────────

/**
 * After a reply was saved (questionService.createReply). The other side of this thread
 * gets one push per window; a later reply inside the window is not pushed (the push they
 * already have opens the same thread). Always resolves with a counts-only summary.
 */
async function notifyReplyCreated(replyId, now = Date.now()) {
  const summary = { event: 'question_reply_push', sent: 0, skipped: {} };
  const skip = r => { summary.skipped[r] = (summary.skipped[r] || 0) + 1; return summary; };
  const at = new Date(now);
  try {
    if (!pushEnabled()) return skip('disabled');
    const r = await QuestionReply.findOneAndUpdate({ _id: replyId, recipientNotifiedAt: null }, { $set: { recipientNotifiedAt: at } }, { new: true }).lean();
    if (!r) return skip('already_handled');
    summary.questionId = String(r.questionId);
    if (r.status !== 'ACTIVE') return skip('reply_gone');
    const [q, a] = await Promise.all([
      Question.findById(r.questionId).select('askerId text status').lean(),
      QuestionAnswer.findById(r.answerId).select('_id authorId status questionId').lean(),
    ]);
    if (!q || q.status === 'DELETED' || q.status === 'HIDDEN') return skip('question_gone');
    if (!a || a.status !== 'ACTIVE' || !same(a.questionId, q._id)) return skip('answer_gone');
    // The recipient is the OTHER side of the thread, from the database.
    let recipientId;
    if (same(r.authorId, q.askerId)) recipientId = a.authorId;
    else if (same(r.authorId, a.authorId)) recipientId = q.askerId;
    else return skip('not_in_thread');
    const toAsker = same(recipientId, q.askerId);

    const users = await User.find({ _id: { $in: [recipientId, r.authorId] } }).select(PUSH_USER_FIELDS).lean();
    const recipient = users.find(u => same(u._id, recipientId));
    const actor = users.find(u => same(u._id, r.authorId));
    // Never the replier themselves: recipientSkip refuses actor === recipient ('self').
    const reason = recipientSkip(recipient, { actor: actor || null, kind: 'reply', now });
    if (reason) return skip(reason);
    if (!actor) return skip('actor_not_active');
    if (await QuestionReport.exists({ reporterId: recipient._id, targetId: a._id })) return skip('reported');

    // One per thread, each way, per window.
    const field = toAsker ? 'replyPush.toAskerAt' : 'replyPush.toAuthorAt';
    const cutoff = new Date(now - REPLY_PUSH_WINDOW_MS);
    const won = await QuestionAnswer.updateOne(
      { _id: a._id, $or: [{ [field]: null }, { [field]: { $lt: cutoff } }] },
      { $set: { [field]: at } },
    );
    if (!won.modifiedCount) return skip('throttled');

    const payload = replyPayload({ question: q, answerId: a._id, replyId: r._id, recipientId: recipient._id, toAsker, actor });
    const tokens = capableTokens(recipient);
    const res = await fcm().sendDataFcm(recipient._id, tokens, payload, { quietLog: true });
    if (res && res.delivered) {
      summary.sent++;
      await audit('QUESTION_REPLY_NOTIFIED', { questionId: q._id, answerId: a._id, targetUserId: recipient._id, meta: { toAsker, devices: tokens.length } });
      return summary;
    }
    skip('fcm_failed');
    // Give the window back (only ours) so the next reply can try again.
    await QuestionAnswer.updateOne({ _id: a._id, [field]: at }, { $set: { [field]: null } });
  } catch (err) {
    summary.error = err && err.name;
    console.error('[QUESTION_PUSH] reply push failed:', err && err.name);
  } finally {
    log(summary);
  }
  return summary;
}

module.exports = {
  dispatch, settle, notifyAnswerCreated, notifyReplyCreated, flushAnswerPushes,
  TYPE_ANSWERED, TYPE_REPLY,
  _internal: {
    ANSWER_PUSH_WINDOW_MS, REPLY_PUSH_WINDOW_MS, PUSH_RETRY_MS, PUSH_STALE_MS, PREVIEW_MAX,
    pushEnabled, clip, questionPreview, firstNameOf, recipientSkip, capableTokens, answeredPayload, replyPayload,
    singleAnswerBody, rollupBody, deepLink, claimOrQueue,
  },
};
