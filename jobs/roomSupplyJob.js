// jobs/roomSupplyJob.js
// -----------------------------------------------------------------------------
// Room supply scheduler: services/roomSupplyService.js (every 10 min) and
// services/roomRecruitService.js (every 5 min).
//
// Both default OFF and are switched on separately:
//   ROOM_SUPPLY_ENABLED=true    show/put away Humrah-hosted Rooms (5 minus user Rooms)
//   ROOM_RECRUIT_ENABLED=true   notify people after someone joins a Humrah-hosted Room
//
// Same safety as the other Room jobs: one worker across instances (Redis lock; refuses
// to run in production without Redis), never throws into the scheduler.
// -----------------------------------------------------------------------------
'use strict';

const redisService = require('../services/redisService');
const { runRoomSupply } = require('../services/roomSupplyService');
const { processRoomRecruitment } = require('../services/roomRecruitService');

const flag = (name) => String(process.env[name] || 'false').trim().toLowerCase() === 'true';

const SUPPLY_LOCK = 'lock:room_supply';
const RECRUIT_LOCK = 'lock:room_recruit';

function canGuaranteeSingleWorker() {
  if (redisService.getClient && redisService.getClient()) return true;
  return process.env.NODE_ENV !== 'production';
}

async function withLock(key, ttlSeconds, fn) {
  if (!canGuaranteeSingleWorker()) return { skipped: 'redis_unavailable' };
  let locked = false;
  try {
    locked = await redisService.acquireLock(key, ttlSeconds);
    if (!locked) return { skipped: 'already_running' };
    return await fn();
  } catch (err) {
    console.error('[RoomSupplyJob]', key, err.message);
    return { failed: true };
  } finally {
    if (locked) {
      try { await redisService.releaseLock(key); } catch (_) { /* TTL clears it */ }
    }
  }
}

const runSupplyOnce = () => withLock(SUPPLY_LOCK, 120, () => runRoomSupply());
const runRecruitOnce = () => withLock(RECRUIT_LOCK, 240, () => processRoomRecruitment());

function every(minutes, fn, firstDelayMs) {
  const first = setTimeout(() => fn().catch(() => {}), firstDelayMs);
  if (first.unref) first.unref();
  const h = setInterval(() => fn().catch(() => {}), minutes * 60 * 1000);
  if (h.unref) h.unref();
  return h;
}

function startRoomSupplyJobs() {
  const supply = flag('ROOM_SUPPLY_ENABLED');
  const recruit = flag('ROOM_RECRUIT_ENABLED');
  console.log(`[RoomSupplyJob] supply ${supply ? 'ON' : 'off'}, recruit notifications ${recruit ? 'ON' : 'off'}`);
  return {
    supply: supply ? every(10, runSupplyOnce, 60 * 1000) : null,
    recruit: recruit ? every(5, runRecruitOnce, 3 * 60 * 1000) : null,
  };
}

module.exports = { startRoomSupplyJobs, runSupplyOnce, runRecruitOnce, SUPPLY_LOCK, RECRUIT_LOCK };
