// utils/surpriseMeetupMatcher.js
//
// Sequential, calm, staged matchmaking for Humrah Surprise Meetup.
//
// MODES:
//   STANDARD — meetup > 30 min away → deep compatibility, 90s reserve window
//   FAST     — meetup ≤ 30 min away → online/nearby priority, 45s reserve window
//
// STAGES (escalation if stage exhausted):
//   Stage 1 — verified, top compatibility, radius 10km, all filters
//   Stage 2 — verified, relaxed compatibility, radius 20km
//   Stage 3 — verified, any nearby, radius 30km
//
// LOCATION POLICY (Requirements §5, §6):
//   - Candidate matching uses user.liveLocation.lat/lng ONLY.
//   - profileCity / questionnaire.city is NEVER used for matching.
//   - Users with missing liveLocation are excluded from candidate pool.
//   - Users whose liveLocation.updatedAt is older than 60 min are excluded (stale).
//   - The booking's matchSearchLocation (frozen at creation) is the reference
//     point for distance calculations, so initiator movement later doesn't
//     change an active search.
//
// FCM RULE: SURPRISE_MEETUP_REQUEST is sent as DATA-ONLY (no `notification` block).
// This prevents Android from auto-displaying the notification before onMessageReceived
// runs, and stops the double-notification caused by handleNotificationMessage fallback.
//
// Never sends to unverified users.
// FCM + WebSocket hybrid: if socket connected → ws only; else → FCM.

'use strict';

const mongoose      = require('mongoose');
const RandomBooking = require('../models/RandomBooking');
const User          = require('../models/User');
const admin         = require('../config/firebase');

// ── Constants ──────────────────────────────────────────────────────────────────
const STAGE_CONFIG = [
  { stage: 1, radiusKm: 10, minScore: 30, label: 'top match' },
  { stage: 2, radiusKm: 20, minScore: 15, label: 'nearby match' },
  { stage: 3, radiusKm: 30, minScore: 0,  label: 'broad match' },
];
const MAX_QUEUE_PER_STAGE    = 6;
const LIVE_LOCATION_STALE_MS = 60 * 60 * 1000;

const ENERGY_VIBE_MAP = {
  QUIET:           ['calm', 'peaceful', 'introvert', 'chill', 'quiet'],
  CHILL:           ['chill', 'relaxed', 'easygoing', 'mellow'],
  DEEP_TALK:       ['deep', 'thoughtful', 'curious', 'meaningful', 'intellectual'],
  FUN:             ['fun', 'playful', 'adventurous', 'spontaneous', 'energetic'],
  STUDY_BUDDY:     ['focused', 'productive', 'studious', 'intellectual'],
  CREATIVE_VIBES:  ['creative', 'artistic', 'expressive', 'imaginative'],
  SOCIAL_RECHARGE: ['social', 'warm', 'friendly', 'open'],
  LOW_ENERGY:      ['calm', 'slow', 'introvert', 'homebody', 'chill'],
};

// ── Distance ───────────────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function toRad(v) { return v * Math.PI / 180; }

// ── Live location freshness check ─────────────────────────────────────────────
function hasValidLiveLocation(user) {
  const ll = user.liveLocation;
  if (!ll || ll.lat == null || ll.lng == null) return false;
  if (!ll.updatedAt) return false;
  return (Date.now() - new Date(ll.updatedAt).getTime()) <= LIVE_LOCATION_STALE_MS;
}

// ── Scoring ────────────────────────────────────────────────────────────────────
function scoreCandidate(booking, candidate) {
  let score = 0;
  const isFast = booking.matchMode === 'FAST';
  const maxRad = STAGE_CONFIG[booking.matchStage - 1]?.radiusKm || 20;
  const q      = candidate.questionnaire || {};

  const distMax = isFast ? 35 : 30;
  score += Math.max(0, distMax - (candidate.distance / maxRad) * distMax);

  const energies  = booking.meetupEnergy || [];
  const candVibes = (q.vibeWords || []).map(v => v.toLowerCase());
  let energyMatch = 0;
  for (const e of energies) {
    const hints = ENERGY_VIBE_MAP[e] || [];
    energyMatch += hints.filter(h => candVibes.some(v => v.includes(h))).length;
  }
  score += Math.min(25, (energyMatch / Math.max(energies.length * 3, 1)) * 25);

  const initVibes   = (booking._initiatorVibes || []).map(v => v.toLowerCase());
  const vibeOverlap = initVibes.filter(v => candVibes.some(cv => cv.includes(v) || v.includes(cv))).length;
  score += Math.min(15, vibeOverlap * 3);

  const initComfort = (booking._initiatorComfort || []).map(c => c.toLowerCase());
  const candComfort = (q.comfortZones || []).map(c => c.toLowerCase());
  score += Math.min(10, initComfort.filter(c => candComfort.includes(c)).length * 3.3);

  const initHangout = (booking._initiatorHangout || []).map(h => h.toLowerCase());
  const candHangout = (q.hangoutPreferences || []).map(h => h.toLowerCase());
  score += Math.min(10, initHangout.filter(h => candHangout.includes(h)).length * 2.5);

  const initSocial = (booking._initiatorSocialEnergy || '').toLowerCase();
  const candSocial = (q.socialEnergy || '').toLowerCase();
  if (initSocial && candSocial && initSocial === candSocial) score += 5;

  if (q.availability && booking._startHourIST != null) {
    const avail = q.availability.toLowerCase();
    const h     = booking._startHourIST;
    const match = (h < 12 && avail.includes('morning')) ||
                  (h >= 12 && h < 17 && avail.includes('afternoon')) ||
                  (h >= 17 && (avail.includes('evening') || avail.includes('night')));
    if (match) score += 5;
  }

  if (isFast && candidate.recentlyActive) score += 5;
  if (candidate.verified || candidate.photoVerificationStatus === 'approved') score += 5;

  return Math.round(score * 10) / 10;
}

// ── Build candidate queue for one stage ───────────────────────────────────────
async function buildQueueForStage(booking, initiator, stage) {
  const cfg = STAGE_CONFIG[stage - 1];
  booking._initiatorVibes        = initiator.questionnaire?.vibeWords         || [];
  booking._initiatorHangout      = initiator.questionnaire?.hangoutPreferences || [];
  booking._initiatorComfort      = initiator.questionnaire?.comfortZones       || [];
  booking._initiatorSocialEnergy = initiator.questionnaire?.socialEnergy       || '';

  const startIST        = new Date(booking.startTime.getTime() + 5.5 * 3600 * 1000);
  booking._startHourIST = startIST.getUTCHours();

  const recentThreshold = new Date(Date.now() - 30 * 60 * 1000);

  const origin = booking.getMatchingCoords
    ? booking.getMatchingCoords()
    : { lat: booking.lat, lng: booking.lng };

  // FIX: explicit ObjectId cast — prevents type mismatch in $ne filter
  let initiatorObjId;
  try { initiatorObjId = new mongoose.Types.ObjectId(booking.initiatorId.toString()); }
  catch (_) { initiatorObjId = booking.initiatorId; }
  const initiatorStr = booking.initiatorId.toString();

  const candidates = await User.find({
    _id:                      { $ne: initiatorObjId },
    photoVerificationStatus: 'approved',
    'liveLocation.lat':       { $ne: null },
    'liveLocation.lng':       { $ne: null },
    'liveLocation.updatedAt': { $ne: null },
  })
    .select('_id fcmTokens liveLocation verified photoVerificationStatus questionnaire socketId last_active_at')
    .lean();

  console.log(`[Matcher] Stage ${stage} pool: ${candidates.length} users before stale filter`);

  const alreadyQueued = new Set(booking.candidateQueue.map(c => c.userId.toString()));
  let staleCount = 0;

  const scored = candidates
    .filter(u => {
      if (u._id.toString() === initiatorStr) return false; // belt-and-suspenders
      if (alreadyQueued.has(u._id.toString())) return false;
      if (!hasValidLiveLocation(u)) { staleCount++; return false; }
      return true;
    })
    .map(u => {
      const dist = haversineKm(origin.lat, origin.lng, u.liveLocation.lat, u.liveLocation.lng);
      if (dist > cfg.radiusKm) return null;
      const recentlyActive = u.last_active_at && new Date(u.last_active_at) > recentThreshold;
      const s = scoreCandidate(booking, { ...u, distance: dist, recentlyActive });
      if (s < cfg.minScore) return null;
      return { userId: u._id, distance: dist, score: s, fcmTokens: u.fcmTokens || [], socketId: u.socketId || null, stage };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_QUEUE_PER_STAGE)
    .map(({ userId, distance, score, stage: st }) => ({
      userId, distance, score, stage: st, sentAt: null, response: 'PENDING', respondedAt: null
    }));

  console.log(
    `[Matcher] Stage ${stage} (${cfg.label}, r=${cfg.radiusKm}km): ` +
    `${scored.length} queued | ${staleCount} stale excluded`
  );
  return scored;
}

// ── Match mode ─────────────────────────────────────────────────────────────────
function determineMatchMode(startTimeMs) {
  return (startTimeMs - Date.now()) / 60000 <= 30 ? 'FAST' : 'STANDARD';
}

// ── Start matching ─────────────────────────────────────────────────────────────
async function startSurpriseMatching(bookingId) {
  try {
    const booking  = await RandomBooking.findById(bookingId);
    if (!booking) return;

    const initiator = await User.findById(booking.initiatorId).select('questionnaire').lean();
    booking.matchMode  = determineMatchMode(booking.startTime.getTime());
    booking.matchStage = 1;

    let queue = await buildQueueForStage(booking, initiator || {}, 1);

    if (queue.length === 0) {
      queue = await buildQueueForStage(booking, initiator || {}, 2);
      if (queue.length === 0) {
        booking.status = 'EXPIRED'; booking.expiredAt = new Date();
        await booking.save();
        await notifyCreatorNoMatch(booking);
        return;
      }
      booking.matchStage = 2;
    }

    booking.candidateQueue        = queue;
    booking.currentCandidateIndex = -1;
    booking.status                = 'SEARCHING';
    await booking.save();
    await offerToNextCandidate(bookingId);
  } catch (err) {
    console.error('[Matcher] startSurpriseMatching error:', err);
  }
}

// ── Offer to next candidate ────────────────────────────────────────────────────
async function offerToNextCandidate(bookingId) {
  try {
    const booking = await RandomBooking.findById(bookingId);
    if (!booking || !['SEARCHING', 'RESERVED'].includes(booking.status)) return;
    if (booking.isExpired()) {
      booking.status = 'EXPIRED'; booking.expiredAt = new Date();
      await booking.save(); await notifyCreatorNoMatch(booking); return;
    }

    let candidate = booking.advanceToNextCandidate();

    if (!candidate) {
      const initiator = await User.findById(booking.initiatorId).select('questionnaire').lean();
      let escalated   = false;
      for (let nextStage = booking.matchStage + 1; nextStage <= 3; nextStage++) {
        const newQueue = await buildQueueForStage(booking, initiator || {}, nextStage);
        if (newQueue.length > 0) {
          booking.candidateQueue.push(...newQueue);
          booking.matchStage = nextStage;
          await booking.save();
          candidate = booking.advanceToNextCandidate();
          escalated = true;
          console.log(`[Matcher] Escalated to stage ${nextStage}`);
          break;
        }
      }
      if (!escalated || !candidate) {
        booking.status = 'EXPIRED'; booking.expiredAt = new Date();
        await booking.save(); await notifyCreatorNoMatch(booking); return;
      }
    }

    await booking.save();
    await notifyCandidate(booking, candidate);

    const windowSec = booking.matchMode === 'FAST' ? 45 : 90;
    console.log(`[Matcher] → ${booking.matchMode} mode, stage ${booking.matchStage}, score ${candidate.score}, window ${windowSec}s`);
    setTimeout(() => advanceIfTimedOut(bookingId), (windowSec + 3) * 1000);
  } catch (err) {
    console.error('[Matcher] offerToNextCandidate error:', err);
  }
}

// ── Review reservation ─────────────────────────────────────────────────────────
async function reserveForReview(bookingId, candidateUserId) {
  const booking = await RandomBooking.findById(bookingId);
  if (!booking) return { ok: false, reason: 'not_found' };
  if (!['SEARCHING', 'RESERVED'].includes(booking.status)) return { ok: false, reason: 'not_available' };

  const candidate = booking.getCurrentCandidate();
  if (!candidate || candidate.userId.toString() !== candidateUserId.toString()) {
    return { ok: false, reason: 'not_your_turn' };
  }

  const reviewSec = booking.matchMode === 'FAST' ? 55 : 150;
  booking.status          = 'REVIEWING';
  booking.reviewingUntil  = new Date(Date.now() + reviewSec * 1000);
  booking.reviewingUserId = candidateUserId;
  booking.candidateQueue[booking.currentCandidateIndex].response = 'REVIEWING';
  await booking.save();

  setTimeout(() => advanceIfReviewExpired(bookingId), (reviewSec + 3) * 1000);
  console.log(`[Matcher] Booking ${bookingId} REVIEWING by ${candidateUserId} for ${reviewSec}s`);
  return { ok: true, reviewingUntil: booking.reviewingUntil };
}

async function advanceIfReviewExpired(bookingId) {
  try {
    const booking = await RandomBooking.findById(bookingId);
    if (!booking || booking.status !== 'REVIEWING') return;
    if (booking.reviewingUntil && booking.reviewingUntil <= new Date()) {
      booking.candidateQueue[booking.currentCandidateIndex].response    = 'TIMED_OUT';
      booking.candidateQueue[booking.currentCandidateIndex].respondedAt = new Date();
      booking.status = 'SEARCHING'; booking.reservedUntil = null;
      booking.reviewingUntil = null; booking.reviewingUserId = null;
      await booking.save();
      await offerToNextCandidate(bookingId);
    }
  } catch (err) { console.error('[Matcher] advanceIfReviewExpired error:', err); }
}

// ── Advance if timed out ───────────────────────────────────────────────────────
async function advanceIfTimedOut(bookingId) {
  try {
    const booking = await RandomBooking.findById(bookingId);
    if (!booking || !['RESERVED', 'REVIEWING'].includes(booking.status)) return;
    const candidate = booking.getCurrentCandidate();
    if (!candidate || candidate.response === 'ACCEPTED') return;
    const deadline = booking.status === 'REVIEWING' ? booking.reviewingUntil : booking.reservedUntil;
    if (deadline && deadline <= new Date()) {
      booking.candidateQueue[booking.currentCandidateIndex].response    = 'TIMED_OUT';
      booking.candidateQueue[booking.currentCandidateIndex].respondedAt = new Date();
      booking.status = 'SEARCHING'; booking.reservedUntil = null;
      booking.reviewingUntil = null; booking.reviewingUserId = null;
      await booking.save();
      await offerToNextCandidate(bookingId);
    }
  } catch (err) { console.error('[Matcher] advanceIfTimedOut error:', err); }
}

// ── Handle candidate response ──────────────────────────────────────────────────
async function handleCandidateResponse(bookingId, candidateUserId, response) {
  const booking = await RandomBooking.findById(bookingId);
  if (!booking) return { ok: false, reason: 'not_found' };
  if (!['SEARCHING', 'RESERVED', 'REVIEWING'].includes(booking.status)) return { ok: false, reason: 'not_available' };

  const candidate = booking.getCurrentCandidate();
  if (!candidate || candidate.userId.toString() !== candidateUserId.toString()) return { ok: false, reason: 'not_your_turn' };
  if (candidate.response === 'ACCEPTED') return { ok: false, reason: 'already_responded' };

  const now = new Date();

  if (response === 'ACCEPTED') {
    booking.candidateQueue[booking.currentCandidateIndex].response    = 'ACCEPTED';
    booking.candidateQueue[booking.currentCandidateIndex].respondedAt = now;
    booking.status = 'MATCHED'; booking.acceptorId = candidateUserId; booking.matchedAt = now;
    booking.reservedUntil = null; booking.reviewingUntil = null; booking.reviewingUserId = null;
    await booking.save();

    const RandomBookingChat = require('../models/RandomBookingChat');
    const chat = await RandomBookingChat.createForBooking(booking);
    booking.chatId = chat._id;
    await booking.save();

    await notifyCreatorMatched(booking, candidateUserId);
    emitSocket(booking.initiatorId.toString(), 'surprise_meetup_matched', {
      bookingId: booking._id.toString(), chatId: chat._id.toString(),
    });
    return { ok: true, matched: true, chatId: chat._id };
  }

  if (response === 'REJECTED') {
    booking.candidateQueue[booking.currentCandidateIndex].response    = 'REJECTED';
    booking.candidateQueue[booking.currentCandidateIndex].respondedAt = now;
    booking.status = 'SEARCHING'; booking.reservedUntil = null;
    booking.reviewingUntil = null; booking.reviewingUserId = null;
    await booking.save();
    setImmediate(() => offerToNextCandidate(bookingId));
    return { ok: true, matched: false };
  }

  return { ok: false, reason: 'invalid_response' };
}

// ── Cron tick ──────────────────────────────────────────────────────────────────
async function tickReservationExpiry() {
  const now   = new Date();
  const stale = await RandomBooking.find({
    status: { $in: ['RESERVED', 'REVIEWING'] },
    $or: [{ reservedUntil: { $lt: now, $ne: null } }, { reviewingUntil: { $lt: now, $ne: null } }],
  }).select('_id');
  for (const { _id } of stale) await advanceIfTimedOut(_id);
}

// ── WebSocket helpers ──────────────────────────────────────────────────────────
function emitSocket(userId, event, data) {
  try { const io = global._humrahIo; if (io) io.to(`user:${userId}`).emit(event, data); } catch (_) {}
}

function emitSocketRaw(socketId, event, data) {
  try {
    const io = global._humrahIo;
    if (!io) return false;
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return false;
    socket.emit(event, data);
    return true;
  } catch (_) { return false; }
}

// ── Notify candidate ──────────────────────────────────────────────────────────
// FIX 1: Never notify the initiator (belt-and-suspenders after DB $ne fix).
// FIX 2: FCM sent as DATA-ONLY (no `notification` block).
//   — With a `notification` block, FCM auto-displays the notification itself
//     AND still calls onMessageReceived. This caused:
//       a) double notification on screen
//       b) handleNotificationMessage fallback firing even on the initiator's device
//          (because FCM delivers to ALL tokens sharing the same device)
//   — Data-only means Android shows nothing until onMessageReceived runs,
//     where we already guard with recipientUserId check.
// FIX 3: recipientUserId added to data payload so the Android recipientUserId
//   guard in handleDataMessage can filter it out if delivered to wrong device.
async function notifyCandidate(booking, candidateEntry) {
  const candidateIdStr = candidateEntry.userId.toString();
  const initiatorStr   = booking.initiatorId.toString();

  // Hard guard — never notify the initiator
  if (candidateIdStr === initiatorStr) {
    console.warn(`[Matcher] GUARD: skipping — candidate is the initiator (${initiatorStr})`);
    return;
  }

  const user = await User.findById(candidateEntry.userId)
    .select('fcmTokens firstName socketId')
    .lean();
  if (!user) return;

  const isFast      = booking.matchMode === 'FAST';
  const energyLabel = (booking.meetupEnergy || [])
    .map(e => e.replace(/_/g, ' ').toLowerCase()).join(', ') || 'calm';

  const title = isFast ? '⚡ Surprise Meetup — Happening Soon' : '✨ A compatible meetup is nearby';
  const body  = `A verified person with a similar vibe is free for a ${energyLabel} public meetup${isFast ? ' — happening soon' : ' tonight'}.`;

  // Data payload — includes recipientUserId so Android can self-guard
  const data = {
    type:            'SURPRISE_MEETUP_REQUEST',
    recipientUserId: candidateIdStr,             // FIX 3: Android self-guard
    bookingId:       booking._id.toString(),
    city:            booking.city,
    energies:        (booking.meetupEnergy || []).join(','),
    startTime:       booking.startTime.toISOString(),
    matchMode:       booking.matchMode,
    matchStage:      String(booking.matchStage),
    isFast:          String(isFast),
    flow:            'VIEW_PROFILE_FIRST',
    title,
    body,
  };

  // Try socket first (zero-cost, instant)
  const isOnline = user.socketId && emitSocketRaw(user.socketId, 'surprise_meetup_request', data);
  if (isOnline) {
    console.log(`[Matcher] WS delivered to candidate ${candidateIdStr}`);
    return;
  }

  // Fallback: FCM DATA-ONLY — no `notification` block (FIX 2)
  if (!user.fcmTokens?.length) {
    console.log(`[Matcher] Candidate ${candidateIdStr} offline with no FCM tokens — will poll via /nearby`);
    return;
  }

  try {
    const msg = {
      // FIX 2: NO `notification` block here — data-only so Android's
      // onMessageReceived is the sole handler and we control what shows.
      data,
      tokens:  user.fcmTokens,
      android: {
        priority: 'high',
        ttl:      '90s',
        notification: { channelId: 'humrah_notifications', sound: 'default' },
      },
    };
    const resp = await admin.messaging().sendEachForMulticast(msg);
    console.log(`[Matcher] FCM → candidate ${candidateIdStr}: ${resp.successCount} ok / ${resp.failureCount} fail`);
    if (resp.failureCount > 0) {
      const bad = user.fcmTokens.filter((_, i) => !resp.responses[i].success);
      if (bad.length) await User.updateOne({ _id: user._id }, { $pull: { fcmTokens: { $in: bad } } });
    }
  } catch (fcmErr) {
    console.error('[Matcher] FCM error:', fcmErr.message);
  }
}

// ── Creator notifications ──────────────────────────────────────────────────────
async function notifyCreatorNoMatch(booking) {
  const creator = await User.findById(booking.initiatorId).select('fcmTokens').lean();
  emitSocket(booking.initiatorId.toString(), 'surprise_meetup_expired', { bookingId: booking._id.toString() });
  if (!creator?.fcmTokens?.length) return;
  await admin.messaging().sendEachForMulticast({
    notification: { title: 'No match found this time', body: 'We looked nearby but no one was available. Try again a bit later!' },
    data:         { type: 'SURPRISE_MEETUP_EXPIRED', bookingId: booking._id.toString() },
    tokens:       creator.fcmTokens,
  }).catch(() => {});
}

async function notifyCreatorMatched(booking, acceptorId) {
  const [creator, acceptor] = await Promise.all([
    User.findById(booking.initiatorId).select('fcmTokens').lean(),
    User.findById(acceptorId).select('firstName').lean(),
  ]);
  emitSocket(booking.initiatorId.toString(), 'surprise_meetup_matched', {
    bookingId: booking._id.toString(), chatId: booking.chatId?.toString() || '', acceptorId: acceptorId.toString(),
  });
  if (!creator?.fcmTokens?.length) return;
  await admin.messaging().sendEachForMulticast({
    notification: { title: '✨ Someone accepted your meetup', body: `${acceptor?.firstName || 'Someone'} accepted. Open the chat to plan your meetup!` },
    data:         { type: 'SURPRISE_MEETUP_MATCHED', bookingId: booking._id.toString(), chatId: booking.chatId?.toString() || '', acceptorId: acceptorId.toString() },
    tokens:       creator.fcmTokens,
  }).catch(() => {});
}

module.exports = { startSurpriseMatching, offerToNextCandidate, reserveForReview, handleCandidateResponse, tickReservationExpiry, haversineKm };
