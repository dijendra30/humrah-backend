// services/meetup/meetupRateLimitService.js
// -----------------------------------------------------------------------------
// R7.1 — per-user Meetup proposal quota (spec §9).
//
//   3 proposals per ROLLING 24 hours
//  10 proposals per ROLLING 7 days
//
// WHY NOT redisService.incrementWithWindow: that primitive is a FIXED window keyed
// by a clock bucket. Under a fixed window a user can spend the whole quota at
// 23:59 and the whole quota again at 00:01. For a limit whose purpose is to stop
// Meetup spam, that doubling matters, so this uses a genuine rolling window.
//
// ONE Redis sorted set per user holds the timestamps of their SUCCESSFUL proposals.
// Both windows are read from that single key, so a request rejected by the 7-day
// limit cannot have already consumed a slot from the 24-hour one.
//
// ATOMICITY: the whole trim/count/count/admit sequence runs as one Lua script, so
// concurrent requests cannot both observe "one slot left" and both take it. There
// is no GET-then-INCR anywhere in this file. A REJECTED request consumes nothing —
// the ZADD happens only on the admit branch.
//
// FAILS CLOSED (spec §9): no Redis client, or any Redis error, means the quota
// cannot be enforced, so the proposal is refused. Unlimited Meetup creation during
// an outage is the one outcome this control exists to prevent. Nothing else in
// Rooms is affected — this function is only ever called on the Meetup path.
// -----------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const redisService = require('../redisService');
const { MEETUP_CONFIG } = require('./meetupConfig');
const { emitMeetupEvent, MEETUP_EVENT } = require('./meetupTelemetry');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Namespaced under `meetup:` — cannot collide with R5 or R6 keys. */
const quotaKey = (userId) => `meetup:proposals:${userId}`;
const attemptKey = (userId) => `meetup:attempts:${userId}`;

/**
 * Rolling dual-window admission.
 *
 * KEYS[1] the user's proposal sorted set
 * ARGV    1 now(ms)  2 cutoff7d  3 cutoff24h  4 limit24h  5 limit7d  6 member  7 ttl(ms)
 *
 * Returns { admitted, count24h, count7d, blockingWindowHours }.
 */
const ROLLING_QUOTA_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local cutoff7d = tonumber(ARGV[2])
local cutoff24h = tonumber(ARGV[3])
local limit24h = tonumber(ARGV[4])
local limit7d = tonumber(ARGV[5])
local member = ARGV[6]
local ttl = tonumber(ARGV[7])

redis.call('ZREMRANGEBYSCORE', key, 0, cutoff7d)

local count7d = redis.call('ZCARD', key)
local count24h = redis.call('ZCOUNT', key, cutoff24h, '+inf')

if count24h >= limit24h then
  redis.call('PEXPIRE', key, ttl)
  return {0, count24h, count7d, 24}
end

if count7d >= limit7d then
  redis.call('PEXPIRE', key, ttl)
  return {0, count24h, count7d, 168}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, ttl)
return {1, count24h + 1, count7d + 1, 0}
`;

/** True only when a real Redis client exists — the in-process map is not one. */
function redisAvailable() {
  try {
    return Boolean(redisService.getClient && redisService.getClient());
  } catch (_) {
    return false;
  }
}

/**
 * Coarse guard on ATTEMPTS, as opposed to successful proposals.
 *
 * Without it a caller could hammer the endpoint with requests that fail an early
 * eligibility check, never touching the quota, while generating unbounded
 * structured logs. Uses the existing fixed-window primitive and FAILS OPEN, exactly
 * like the roomGuards limiters — it is anti-noise, not a safety control, and the
 * quota below is what actually protects Meetup creation.
 */
async function registerAttempt(userId) {
  try {
    const count = await redisService.incrementWithWindow(attemptKey(userId), 3600);
    return { allowed: count <= MEETUP_CONFIG.ATTEMPT_LIMIT_PER_HOUR, attempts: count };
  } catch (err) {
    return { allowed: true, attempts: 0 };
  }
}

/**
 * Consumes ONE proposal slot if both rolling windows permit it.
 *
 * @returns {Promise<{allowed:boolean, reason?:string, proposalsLast24h:number,
 *                    proposalsLast7d:number, limit?:number, window?:string,
 *                    receipt?:string}>}
 *          `receipt` identifies the exact sorted-set member that was added, so a
 *          later failure can hand the slot back via refund().
 */
async function consumeProposalSlot(userId, { now = Date.now() } = {}) {
  if (!redisAvailable()) {
    emitMeetupEvent(MEETUP_EVENT.REDIS_UNAVAILABLE, { userId: String(userId), reason: 'quota_unavailable' });
    return { allowed: false, reason: 'redis_unavailable', proposalsLast24h: 0, proposalsLast7d: 0 };
  }

  const client = redisService.getClient();
  const key = quotaKey(userId);
  // Unique per attempt so two proposals in the same millisecond are two members.
  const receipt = `${now}-${crypto.randomBytes(6).toString('hex')}`;

  let raw;
  try {
    raw = await client.eval(
      ROLLING_QUOTA_LUA, 1, key,
      String(now),
      String(now - WEEK_MS),
      String(now - DAY_MS),
      String(MEETUP_CONFIG.PROPOSAL_LIMIT_24H),
      String(MEETUP_CONFIG.PROPOSAL_LIMIT_7D),
      receipt,
      String(WEEK_MS)
    );
  } catch (err) {
    emitMeetupEvent(MEETUP_EVENT.REDIS_UNAVAILABLE, { userId: String(userId), reason: 'quota_write_failed' });
    return { allowed: false, reason: 'redis_error', proposalsLast24h: 0, proposalsLast7d: 0 };
  }

  const [admitted, count24h, count7d, blockingWindow] = (raw || []).map(Number);

  if (admitted !== 1) {
    const window = blockingWindow === 24 ? '24h' : '7d';
    emitMeetupEvent(MEETUP_EVENT.RATE_LIMITED, {
      userId: String(userId),
      proposalsLast24h: count24h,
      proposalsLast7d: count7d,
      window,
      limit: window === '24h' ? MEETUP_CONFIG.PROPOSAL_LIMIT_24H : MEETUP_CONFIG.PROPOSAL_LIMIT_7D,
    });
    return {
      allowed: false,
      reason: window === '24h' ? 'daily_quota_exhausted' : 'weekly_quota_exhausted',
      proposalsLast24h: count24h,
      proposalsLast7d: count7d,
      limit: window === '24h' ? MEETUP_CONFIG.PROPOSAL_LIMIT_24H : MEETUP_CONFIG.PROPOSAL_LIMIT_7D,
      window,
    };
  }

  return { allowed: true, proposalsLast24h: count24h, proposalsLast7d: count7d, receipt };
}

/**
 * Hands back a slot consumed by a proposal that then failed to be created — for
 * example when the database's one-active-Meetup index rejected the insert.
 *
 * Best-effort by design: a failed refund only means the user's own quota is one
 * stricter than it needed to be, which is the safe direction. It can never grant
 * extra capacity, because it removes one specific member it created.
 */
async function refundProposalSlot(userId, receipt) {
  if (!receipt || !redisAvailable()) return false;
  try {
    await redisService.getClient().zrem(quotaKey(userId), receipt);
    return true;
  } catch (_) {
    return false;
  }
}

/** Read-only view for diagnostics. Consumes nothing. */
async function getQuotaUsage(userId, { now = Date.now() } = {}) {
  if (!redisAvailable()) return { ok: false, proposalsLast24h: 0, proposalsLast7d: 0 };
  try {
    const client = redisService.getClient();
    const key = quotaKey(userId);
    const [count7d, count24h] = await Promise.all([
      client.zcount(key, now - WEEK_MS, '+inf'),
      client.zcount(key, now - DAY_MS, '+inf'),
    ]);
    return { ok: true, proposalsLast24h: Number(count24h) || 0, proposalsLast7d: Number(count7d) || 0 };
  } catch (_) {
    return { ok: false, proposalsLast24h: 0, proposalsLast7d: 0 };
  }
}

module.exports = {
  consumeProposalSlot,
  refundProposalSlot,
  registerAttempt,
  getQuotaUsage,
  redisAvailable,
  quotaKey,
  attemptKey,
  ROLLING_QUOTA_LUA,
  DAY_MS,
  WEEK_MS,
};
