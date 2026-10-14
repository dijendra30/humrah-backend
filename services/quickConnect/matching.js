// services/quickConnect/matching.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 5): server-authoritative one-to-one matching.
//
// SEARCHING is a row in quickconnectsearches (_id = userId → one search per user).
// A matcher pairs two searchers atomically:
//   1. claims the candidate's row, then the searcher's own row (SEARCHING → PAIRING,
//      each a conditional write carrying a random pairing token);
//   2. re-runs evaluateEligibility for BOTH (consent, age, allow-list, verification,
//      account state, busy) and re-checks the block pair;
//   3. reserves both through createSession(..., PROPOSED) — the shared Agora/QC hold;
//   4. deletes both rows only if both still carry its token (a cancel in between wins:
//      the new session is cancelled and released).
// Any failure returns the other row to SEARCHING. No transaction is needed.
//
// Order: shared interests first (most shared, then longest waiting). Without a shared
// interest a pair is allowed only once either side has waited past the fallback delay
// (QUICK_CONNECT_MATCH_FALLBACK_MS, default 20 s). Blocks in either direction exclude a
// pair. Interests come from the user's own questionnaire answers on the server — never
// from the client — and only shared labels are ever shown to the other person.
//
// Single-instance assumption: the broadened-matching pass runs inside the sweeper of the
// one backend process. All writes are conditional, so a second process would only be
// redundant, never unsafe — but see the Phase 5 report before scaling out.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const User = require('../../models/User');
const QuickConnectSearch = require('../../models/QuickConnectSearch');
const QuickConnectSession = require('../../models/QuickConnectSession');
const config = require('./config');
const sessions = require('./sessions');
const { evaluateEligibility } = require('./eligibility');
const notify = require('./notify');

const INTEREST_FIELDS = ['interests', 'hobbies', 'conversationInterests', 'humrahRoomInterests'];
const MAX_INTERESTS = 60;
const MAX_LABEL = 60;
const MAX_SHARED_SHOWN = 5;
const CANDIDATES_PER_TRY = 10;
const PAIRING_STALE_MS = 30 * 1000;

/** One label → normalized form ("  Tech &  Gadgets " → "tech & gadgets"), or null. */
function normalizeLabel(v) {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')          // leading emoji / bullets
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 2 && s.length <= MAX_LABEL ? s : null;
}

/** All interest answers of a questionnaire, normalized and de-duplicated. Arrays or comma strings. */
function normalizeInterests(questionnaire) {
  const out = new Set();
  const q = questionnaire || {};
  for (const field of INTEREST_FIELDS) {
    const raw = q[field];
    const items = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
    for (const item of items) {
      const n = normalizeLabel(item);
      if (n) out.add(n);
      if (out.size >= MAX_INTERESTS) return [...out];
    }
  }
  return [...out];
}

async function blockedEitherWay(a, b) {
  return !!(await User.exists({ $or: [{ _id: a, blockedUsers: b }, { _id: b, blockedUsers: a }] }));
}

async function revert(userId, token) {
  await QuickConnectSearch.updateOne({ _id: userId, pairingToken: token, status: 'PAIRING' },
    { $set: { status: 'SEARCHING', pairingToken: null, pairingAt: null } });
}
async function drop(userId, token, reason) {
  const r = await QuickConnectSearch.deleteOne({ _id: userId, pairingToken: token });
  if (r.deletedCount > 0) notify.toUser(userId, 'qc_search_ended', { reason });
}

async function peerCard(userId) {
  const u = await User.findById(userId).select('firstName profilePhoto').lean();
  return { firstName: (u && u.firstName) || 'Someone', profilePhoto: (u && u.profilePhoto) || null };
}

async function announceProposal(session, shared) {
  const [a, b] = session.participants.map(String);
  const expiresAt = new Date(new Date(session.proposedAt).getTime() + QuickConnectSession.PROPOSAL_TIMEOUT_MS).toISOString();
  const [cardA, cardB] = await Promise.all([peerCard(a), peerCard(b)]);
  const base = { sessionId: String(session._id), expiresAt, matchType: session.matchType, sharedInterests: shared.slice(0, MAX_SHARED_SHOWN) };
  notify.toUser(a, 'qc_match_proposed', { ...base, peer: cardB });
  notify.toUser(b, 'qc_match_proposed', { ...base, peer: cardA });
}

/**
 * Pairs `me` with `cand` (both search rows, lean). Returns the PROPOSED session, null when
 * this candidate did not work out, or 'SELF_GONE' when `me` is no longer searching.
 */
async function pairUp(me, cand, now) {
  const token = crypto.randomBytes(12).toString('hex');
  const claim = id => QuickConnectSearch.findOneAndUpdate(
    { _id: id, status: 'SEARCHING' },
    { $set: { status: 'PAIRING', pairingToken: token, pairingAt: new Date(now) } },
    { new: true }
  ).lean();
  if (!(await claim(cand._id))) return null;
  if (!(await claim(me._id))) { await revert(cand._id, token); return 'SELF_GONE'; }

  const [eMe, eCand] = await Promise.all([evaluateEligibility(me._id, { now }), evaluateEligibility(cand._id, { now })]);
  if (!eMe.eligible || !eCand.eligible) {
    for (const [row, e] of [[me, eMe], [cand, eCand]]) {
      if (e.eligible) await revert(row._id, token);
      else await drop(row._id, token, e.code === 'BUSY' ? 'busy' : 'not_eligible');
    }
    return eMe.eligible ? null : 'SELF_GONE';
  }
  if (await blockedEitherWay(me._id, cand._id)) {
    await revert(me._id, token); await revert(cand._id, token);
    return null;
  }

  const shared = me.interests.filter(i => cand.interests.includes(i));
  const created = await sessions.createSession(me._id, cand._id, {
    now, initialStatus: 'PROPOSED',
    matchType: shared.length > 0 ? 'interest' : 'broadened',
    sharedInterestCount: shared.length
  });
  if (!created.ok) {
    if (created.code === 'BUSY') {
      const busy = String(created.busyUserId);
      for (const row of [me, cand]) {
        if (String(row._id) === busy) await drop(row._id, token, 'busy');
        else await revert(row._id, token);
      }
      return busy === String(me._id) ? 'SELF_GONE' : null;
    }
    await revert(me._id, token); await revert(cand._id, token);   // e.g. switched off meanwhile
    return 'SELF_GONE';
  }

  const removed = await QuickConnectSearch.deleteMany({ _id: { $in: [me._id, cand._id] }, pairingToken: token });
  if (removed.deletedCount !== 2) {
    // One of them cancelled while we were reserving: undo the session, keep the other searching.
    await sessions.endSession(created.session._id, 'cancelled');
    await revert(me._id, token); await revert(cand._id, token);
    return null;
  }
  await announceProposal(created.session, shared);
  return created.session;
}

/** Tries to match `userId`'s open search now. Returns the PROPOSED session or null. */
async function tryMatch(userId, { now = Date.now() } = {}) {
  if (!config.isEnabled()) return null;
  const me = await QuickConnectSearch.findOne({ _id: userId, status: 'SEARCHING' }).lean();
  if (!me) return null;
  const [mine, blockers] = await Promise.all([
    User.findById(userId).select('blockedUsers').lean(),
    User.find({ blockedUsers: me._id }).select('_id').limit(5000).lean()
  ]);
  const exclude = [me._id, ...((mine && mine.blockedUsers) || []), ...blockers.map(b => b._id)];
  const broadened = new Date(me.broadenAt).getTime() <= now;
  const candidates = await QuickConnectSearch.aggregate([
    { $match: { status: 'SEARCHING', _id: { $nin: exclude } } },
    { $addFields: { shared: { $size: { $setIntersection: ['$interests', me.interests] } } } },
    { $match: broadened ? {} : { $or: [{ shared: { $gt: 0 } }, { broadenAt: { $lte: new Date(now) } }] } },
    { $sort: { shared: -1, startedAt: 1 } },
    { $limit: CANDIDATES_PER_TRY }
  ]);
  for (const cand of candidates) {
    const r = await pairUp(me, cand, now);
    if (r === 'SELF_GONE') return null;
    if (r) return r;
  }
  return null;
}

/**
 * Starts a search for the AUTHENTICATED user. Resolves
 *   { ok: true, state: 'searching' | 'proposed', alreadySearching?, sessionId? }
 *   { ok: false, code }   (QUICK_CONNECT_DISABLED, an eligibility code, ...)
 */
async function startSearch(userId, { auth = null, now = Date.now() } = {}) {
  if (!config.isEnabled()) return { ok: false, code: 'QUICK_CONNECT_DISABLED' };
  if (await QuickConnectSearch.exists({ _id: userId })) return { ok: true, state: 'searching', alreadySearching: true };
  const e = await evaluateEligibility(userId, { auth, now });
  if (!e.eligible) return { ok: false, code: e.code };

  const user = await User.findById(userId).select('questionnaire.interests questionnaire.hobbies questionnaire.conversationInterests questionnaire.humrahRoomInterests').lean();
  try {
    await QuickConnectSearch.create({
      _id: userId,
      interests: normalizeInterests(user && user.questionnaire),
      startedAt: new Date(now),
      broadenAt: new Date(now + config.matchFallbackMs()),
      expiresAt: new Date(now + config.searchTimeoutMs())
    });
  } catch (err) {
    if (err && err.code === 11000) return { ok: true, state: 'searching', alreadySearching: true };
    throw err;
  }
  // Simultaneous starts can all back off from each other (each matcher yields when its own
  // row was claimed). Retry a couple of times with jitter; the sweeper's pass catches the rest.
  let session = await tryMatch(userId, { now });
  for (let i = 0; !session && i < 2; i++) {
    await new Promise(r => setTimeout(r, 40 + Math.floor(Math.random() * 160)));
    if (!(await QuickConnectSearch.exists({ _id: userId, status: 'SEARCHING' }))) break;
    session = await tryMatch(userId);
  }
  if (session) return { ok: true, state: 'proposed', sessionId: String(session._id) };
  const proposed = await QuickConnectSession.findOne({ participants: userId, status: 'PROPOSED' }).select('_id').lean();
  return proposed ? { ok: true, state: 'proposed', sessionId: String(proposed._id) } : { ok: true, state: 'searching' };
}

/** Cancels the user's own search (no-op when none). Works while switched off. */
async function cancelSearch(userId) {
  const r = await QuickConnectSearch.deleteOne({ _id: userId });
  return { ok: true, cancelled: r.deletedCount > 0 };
}

/**
 * Matching pass for the sweeper: expires old searches, frees rows stuck in PAIRING after a
 * crash, and retries open searches (this is where broadened matches happen).
 */
async function matchTick({ now = Date.now(), limit = 50 } = {}) {
  const counters = { searchesExpired: 0, pairingFreed: 0, matched: 0 };
  const expired = await QuickConnectSearch.find({ expiresAt: { $lte: new Date(now) }, status: 'SEARCHING' }).select('_id').limit(200).lean();
  for (const s of expired) {
    const r = await QuickConnectSearch.deleteOne({ _id: s._id, status: 'SEARCHING', expiresAt: { $lte: new Date(now) } });
    if (r.deletedCount > 0) { counters.searchesExpired++; notify.toUser(s._id, 'qc_search_ended', { reason: 'timeout' }); }
  }
  const freed = await QuickConnectSearch.updateMany(
    { status: 'PAIRING', pairingAt: { $lt: new Date(now - PAIRING_STALE_MS) } },
    { $set: { status: 'SEARCHING', pairingToken: null, pairingAt: null } }
  );
  counters.pairingFreed = freed.modifiedCount;
  if (!config.isEnabled()) return counters;
  const open = await QuickConnectSearch.find({ status: 'SEARCHING' }).sort({ startedAt: 1 }).select('_id').limit(limit).lean();
  for (const s of open) if (await tryMatch(s._id, { now })) counters.matched++;
  return counters;
}

/** Removes every open search (kill switch). Each user is told once. */
async function clearAllSearches(reason = 'unavailable') {
  const rows = await QuickConnectSearch.find({}).select('_id').limit(1000).lean();
  let n = 0;
  for (const r of rows) {
    const d = await QuickConnectSearch.deleteOne({ _id: r._id });
    if (d.deletedCount > 0) { n++; notify.toUser(r._id, 'qc_search_ended', { reason }); }
  }
  return n;
}

async function searchOf(userId, now = Date.now()) {
  const s = await QuickConnectSearch.findById(userId).select('startedAt broadenAt').lean();
  if (!s) return null;
  return { startedAt: new Date(s.startedAt).toISOString(), broadened: new Date(s.broadenAt).getTime() <= now };
}

module.exports = {
  normalizeInterests, normalizeLabel, startSearch, cancelSearch, tryMatch, matchTick, clearAllSearches, searchOf,
  _internal: { pairUp }
};
