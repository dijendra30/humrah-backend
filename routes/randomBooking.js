// routes/randomBooking.js
'use strict';

const express           = require('express');
const router            = express.Router();
const mongoose          = require('mongoose');
const { auth }          = require('../middleware/auth');
const { authenticate }  = require('../middleware/auth');
const RandomBooking     = require('../models/RandomBooking');
const BookingMatch      = require('../models/BookingMatch');
const RandomBookingChat = require('../models/RandomBookingChat');
const Message           = require('../models/Message');
const User              = require('../models/User');

// ── Helpers ───────────────────────────────────────────────────────────────────
function toRad(v) { return v * Math.PI / 180; }
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Live location freshness ────────────────────────────────────────────────────
const LIVE_LOCATION_STALE_MS = 60 * 60 * 1000; // 60 minutes
function hasValidLiveLocation(user) {
  const ll = user.liveLocation;
  if (!ll || ll.lat == null || ll.lng == null) return false;
  if (!ll.updatedAt) return false;
  return (Date.now() - new Date(ll.updatedAt).getTime()) <= LIVE_LOCATION_STALE_MS;
}

const CITY_BOUNDARIES = {
  Delhi:     { center: { lat: 28.7041, lng: 77.1025 }, radius: 30 },
  Mumbai:    { center: { lat: 19.0760, lng: 72.8777 }, radius: 25 },
  Bangalore: { center: { lat: 12.9716, lng: 77.5946 }, radius: 30 },
  Hyderabad: { center: { lat: 17.3850, lng: 78.4867 }, radius: 25 },
  Chennai:   { center: { lat: 13.0827, lng: 80.2707 }, radius: 25 },
};

async function validateCityLocation(lat, lng, selectedCity) {
  const city = CITY_BOUNDARIES[selectedCity];
  if (!city) return true;
  const dist = calculateDistance(lat, lng, city.center.lat, city.center.lng);
  console.log(`📍 GPS: ${dist.toFixed(2)} km from ${selectedCity} — within: ${dist <= city.radius}`);
  return dist <= city.radius;
}

const VALID_ENERGIES = new Set([
  'QUIET','CHILL','DEEP_TALK','FUN','STUDY_BUDDY','CREATIVE_VIBES','SOCIAL_RECHARGE','LOW_ENERGY'
]);

function parseStartTime(startTime) {
  if (startTime.includes('T')) return new Date(startTime);
  const [h, m] = startTime.split(':').map(Number);
  const now = new Date();
  let utcH = h - 5, utcM = m - 30;
  if (utcM < 0) { utcH -= 1; utcM += 60; }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcH, utcM, 0, 0));
}

// ══════════════════════════════════════════════════════════════════════════════
// STATIC ROUTES FIRST — must all come before /:bookingId
// ══════════════════════════════════════════════════════════════════════════════

// ── CREATE ────────────────────────────────────────────────────────────────────
router.post('/create', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select(
      'random_trial_used verified photoVerificationStatus home_city questionnaire liveLocation'
    );
    const isVerified = user.verified === true || user.photoVerificationStatus === 'approved';
    if (!isVerified) return res.status(403).json({ success: false, message: 'Only verified users can create a Surprise Meetup.' });
    if (user.random_trial_used) return res.status(403).json({ success: false, message: 'You have already used your free trial.' });

    const { city, lat, lng, startTime, endTime, activityType, locationCategory, meetupEnergy, blurProfileUntilAccepted } = req.body;
    const isSurpriseMeetup = Array.isArray(meetupEnergy) && meetupEnergy.length > 0;

    if (!city || !lat || !lng || !startTime) return res.status(400).json({ success: false, message: 'city, lat, lng, startTime required.' });
    if (!isSurpriseMeetup && !activityType) return res.status(400).json({ success: false, message: 'activityType required for standard bookings.' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ success: false, message: 'Invalid GPS coordinates.' });

    if (isSurpriseMeetup) {
      const bad = meetupEnergy.filter(e => !VALID_ENERGIES.has(e));
      if (bad.length) return res.status(400).json({ success: false, message: `Invalid meetupEnergy values: ${bad.join(', ')}` });
    }

    const bookingStart    = parseStartTime(startTime);
    const bookingStartIST = new Date(bookingStart.getTime() + 5.5 * 3600 * 1000);
    const startHourIST    = bookingStartIST.getUTCHours();
    const startMinuteIST  = bookingStartIST.getUTCMinutes();

    if (startHourIST < 7 || startHourIST > 20 || (startHourIST === 20 && startMinuteIST > 0)) {
      return res.status(400).json({ success: false, message: 'Meetup requests only allowed between 7 AM – 8 PM IST.' });
    }

    const now = new Date();
    if (bookingStart.getTime() - now.getTime() < 20 * 60 * 1000) {
      return res.status(400).json({ success: false, message: 'Please choose a time at least 20 minutes from now.' });
    }

    const maxDate = new Date(now); maxDate.setDate(now.getDate() + 1); maxDate.setHours(23, 59, 59, 999);
    if (bookingStart > maxDate) return res.status(400).json({ success: false, message: 'Requests can only be made for today or tomorrow.' });

    if (!await validateCityLocation(lat, lng, city)) {
      return res.status(400).json({ success: false, message: 'Your location does not match the selected city.' });
    }

    // ── Freeze matchSearchLocation from liveLocation (Requirement §6) ─────────
    // This captures the initiator's position AT THE MOMENT of booking creation.
    // All subsequent matching uses this frozen point — even if liveLocation updates later.
    // Prefer liveLocation (more precise); fall back to request body lat/lng.
    const ll = user.liveLocation;
    const matchSearchLocation = {
      lat:        (ll && ll.lat != null) ? ll.lat : Number(lat),
      lng:        (ll && ll.lng != null) ? ll.lng : Number(lng),
      city:       (ll && ll.city)        ? ll.city  : (city || null),
      state:      (ll && ll.state)       ? ll.state : null,
      capturedAt: now,
    };

    const bookingData = {
      initiatorId:      req.userId,
      city, lat: Number(lat), lng: Number(lng),
      matchSearchLocation,
      activityType:     isSurpriseMeetup ? 'CASUAL' : activityType,
      locationCategory: locationCategory || 'Public Place',
      startTime:        bookingStart,
      endTime:          endTime ? new Date(endTime) : new Date(bookingStart.getTime() + 90 * 60000),
      expiresAt:        new Date(bookingStart.getTime() + 90 * 60 * 1000), // 90 min after meetup start
      status:           'PENDING',
    };
    if (isSurpriseMeetup) {
      bookingData.meetupEnergy             = meetupEnergy;
      bookingData.blurProfileUntilAccepted = blurProfileUntilAccepted === true;
    }

    const booking = await RandomBooking.create(bookingData);

    // Update liveLocation and legacy fields on the user doc
    user.last_known_lat = Number(lat);
    user.last_known_lng = Number(lng);
    user.last_location_updated_at = now;
    // Also update liveLocation if the body provided city/state (refreshes timestamp)
    user.liveLocation = {
      lat:       Number(lat),
      lng:       Number(lng),
      city:      city || user.liveLocation?.city || null,
      state:     user.liveLocation?.state || null,
      updatedAt: now,
    };
    user.random_trial_used = true;
    await user.save();

    if (isSurpriseMeetup) {
      const { startSurpriseMatching } = require('../utils/surpriseMeetupMatcher');
      startSurpriseMatching(booking._id).catch(err => console.error('[Matcher] error:', err));
    } else {
      const { startProgressiveMatching } = require('../utils/progressiveMatching');
      startProgressiveMatching(booking._id);
    }

    return res.status(201).json({
      success: true,
      message: isSurpriseMeetup ? "We're finding your match." : 'Random Meet request created!',
      booking: {
        _id: booking._id, city: booking.city, activityType: booking.activityType,
        meetupEnergy: booking.meetupEnergy, blurProfileUntilAccepted: booking.blurProfileUntilAccepted,
        matchMode: booking.matchMode || 'STANDARD', startTime: booking.startTime,
        endTime: booking.endTime, status: booking.status,
        matchSearchLocation: booking.matchSearchLocation,
      },
    });
  } catch (err) {
    console.error('❌ Create booking error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to create booking.' });
  }
});

// ── TRIAL STATUS ──────────────────────────────────────────────────────────────
router.get('/trial-status', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('random_trial_used verified photoVerificationStatus');
    const isVerified = user.photoVerificationStatus === 'approved';
    return res.json({
      success: true,
      trialUsed:        user.random_trial_used || false,
      verified:         isVerified,
      canCreateBooking: isVerified && !user.random_trial_used,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to check trial status.' });
  }
});

// ── ELIGIBLE ──────────────────────────────────────────────────────────────────
// Uses liveLocation for the requesting user's position (Requirement §5).
// Only returns bookings where the initiator had a fresh liveLocation at booking time.
router.get('/eligible', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('liveLocation last_known_lat last_known_lng');
    if (!user) return res.json({ success: true, bookings: [] });

    // Prefer liveLocation; fall back to legacy flat fields
    let uLat, uLng;
    if (hasValidLiveLocation(user)) {
      uLat = user.liveLocation.lat;
      uLng = user.liveLocation.lng;
    } else if (user.last_known_lat && user.last_known_lng) {
      uLat = user.last_known_lat;
      uLng = user.last_known_lng;
    } else {
      return res.json({ success: true, bookings: [] });
    }

    const all = await RandomBooking.find({
      status:      { $in: ['PENDING', 'SEARCHING'] },
      expiresAt:   { $gt: new Date() },
      initiatorId: { $ne: req.userId },
    }).populate('initiatorId', 'firstName lastName profilePhoto questionnaire verified photoVerificationStatus').lean();

    const eligible = all
      .map(b => {
        // Use frozen matchSearchLocation for distance if available, else booking lat/lng
        const bLat = b.matchSearchLocation?.lat ?? b.lat;
        const bLng = b.matchSearchLocation?.lng ?? b.lng;
        return { ...b, distance: calculateDistance(uLat, uLng, bLat, bLng) };
      })
      .filter(b => b.distance <= 15)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 20);

    return res.json({ success: true, bookings: eligible });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load bookings.' });
  }
});

// ── NEARBY — the card's data source ──────────────────────────────────────────
// Uses liveLocation (from query params lat/lng sent by the frontend).
// The frontend must send fresh coords (from their own liveLocation) — no server-side lookup.
router.get('/nearby', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (lat == null || lng == null || lat === '' || lng === '') return res.status(400).json({ success: false, message: 'GPS coordinates required.' });

    const uLat   = parseFloat(lat);
    const uLng   = parseFloat(lng);
    if (isNaN(uLat) || isNaN(uLng)) return res.status(400).json({ success: false, message: 'Invalid GPS coordinates.' });

    // If client sent 0,0 (GPS unavailable), fall back to user's stored liveLocation
    let effectiveLat = uLat;
    let effectiveLng = uLng;
    if (uLat === 0 && uLng === 0) {
      const user = await User.findById(req.userId).select('liveLocation last_known_lat last_known_lng').lean();
      if (user?.liveLocation?.lat && user?.liveLocation?.lng) {
        effectiveLat = user.liveLocation.lat;
        effectiveLng = user.liveLocation.lng;
      } else if (user?.last_known_lat && user?.last_known_lng) {
        effectiveLat = user.last_known_lat;
        effectiveLng = user.last_known_lng;
      }
    }
    const now    = new Date();
    const userId = req.userId.toString();

    let userObjId;
    try { userObjId = new mongoose.Types.ObjectId(userId); }
    catch(_) { userObjId = userId; }

    // 1. Bookings specifically offered to this user (RESERVED or REVIEWING)
    const reserved = await RandomBooking.find({
      status:         { $in: ['RESERVED', 'REVIEWING'] },
      initiatorId:    { $ne: userObjId },
      expiresAt:      { $gt: now },
      'candidateQueue.userId': userObjId,
    }).populate('initiatorId', 'firstName lastName profilePhoto verified questionnaire photoVerificationStatus').lean();

    const myReserved = reserved.filter(b => {
      const cur = b.candidateQueue?.[b.currentCandidateIndex];
      return cur && cur.userId.toString() === userId && cur.response === 'PENDING';
    });

    // 2. General pool (PENDING / SEARCHING)
    const general = await RandomBooking.find({
      status:      { $in: ['PENDING', 'SEARCHING'] },
      initiatorId: { $ne: userObjId },
      expiresAt:   { $gt: now },
    }).populate('initiatorId', 'firstName lastName profilePhoto verified questionnaire photoVerificationStatus').lean();

    // Merge, deduplicate
    const seen = new Set();
    const all  = [...myReserved, ...general].filter(b => {
      const id = b._id.toString();
      if (seen.has(id)) return false;
      seen.add(id); return true;
    });

    const nearby = all
      .map(b => {
        // Use frozen matchSearchLocation for distance; fall back to booking lat/lng
        const bLat = b.matchSearchLocation?.lat ?? b.lat;
        const bLng = b.matchSearchLocation?.lng ?? b.lng;
        return { ...b, distance: calculateDistance(effectiveLat, effectiveLng, bLat, bLng) };
      })
      .filter(b => b.distance <= 20)
      .sort((a, b) => {
        const aIsMe = myReserved.some(r => r._id.toString() === a._id.toString());
        const bIsMe = myReserved.some(r => r._id.toString() === b._id.toString());
        if (aIsMe && !bIsMe) return -1;
        if (!aIsMe && bIsMe) return 1;
        return a.distance - b.distance;
      })
      .slice(0, 10)
      .map(b => {
        const shouldBlur = b.blurProfileUntilAccepted && b.status !== 'MATCHED';
        const raw        = b.initiatorId || {};
        const initiator  = {
          _id:          raw._id,
          firstName:    shouldBlur ? 'Someone nearby' : (raw.firstName || 'Someone'),
          profilePhoto: shouldBlur ? null : raw.profilePhoto,
          verified:     raw.photoVerificationStatus === 'approved',
          questionnaire: raw.questionnaire || null,
          blurred:      shouldBlur,
        };
        return {
          _id:                      b._id,
          city:                     b.city,
          activityType:             b.activityType,
          meetupEnergy:             b.meetupEnergy || [],
          locationCategory:         b.locationCategory,
          startTime:                b.startTime,
          endTime:                  b.endTime,
          distance:                 parseFloat(b.distance.toFixed(1)),
          status:                   b.status,
          matchMode:                b.matchMode || 'STANDARD',
          blurProfileUntilAccepted: b.blurProfileUntilAccepted,
          reservedUntil:            b.reservedUntil || null,
          createdAt:                b.createdAt,
          // Expose frozen city/state for display (shows all Indian states, not just Bhopal/MP)
          matchSearchLocation:      b.matchSearchLocation
            ? { city: b.matchSearchLocation.city, state: b.matchSearchLocation.state }
            : null,
          reservedUntil:            b.reservedUntil || null,
          initiatorId: initiator,
        };
      });

    console.log(`[/nearby] user=${userId} reserved=${myReserved.length} general=${general.length} returned=${nearby.length} effectiveLoc=${effectiveLat},${effectiveLng}`);
    return res.json({ success: true, bookings: nearby, userLocation: { lat: effectiveLat, lng: effectiveLng } });
  } catch (err) {
    console.error('❌ Get nearby error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load nearby bookings.' });
  }
});

// ── CHATS LIST ────────────────────────────────────────────────────────────────
router.get('/chats', authenticate, async (req, res) => {
  try {
    const chats = await RandomBookingChat.find({ 'participants.userId': req.userId, isDeleted: false })
      .populate({ path: 'participants.userId', select: 'firstName lastName profilePhoto verified questionnaire' })
      .populate({ path: 'bookingId', select: 'city activityType meetupEnergy locationCategory startTime endTime status blurProfileUntilAccepted' })
      .sort({ lastMessageAt: -1 });
    return res.json({ success: true, chats });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load chats.' });
  }
});

// ── CHAT MESSAGES ─────────────────────────────────────────────────────────────
router.get('/chats/:chatId/messages', authenticate, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId)
      .populate('bookingId')
      .populate({ path: 'participants.userId', select: 'firstName lastName profilePhoto verified questionnaire' });
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found.' });

    const uid = req.userId.toString();
    const isParticipant = chat.participants.some(p => {
      const pid = p.userId?._id ? p.userId._id.toString() : p.userId.toString();
      return pid === uid;
    });
    if (!isParticipant) return res.status(403).json({ success: false, message: 'Access denied.' });

    const messages = await Message.find({ chatId: req.params.chatId, isDeleted: false })
      .populate('senderId', 'firstName lastName profilePhoto')
      .sort({ timestamp: 1 }).limit(200);

    const transformed = messages.map(msg => ({
      _id: msg._id.toString(), chatId: msg.chatId.toString(),
      senderId: msg.senderId._id.toString(),
      senderIdRaw: { _id: msg.senderId._id.toString(), firstName: msg.senderId.firstName, lastName: msg.senderId.lastName, profilePhoto: msg.senderId.profilePhoto },
      senderRole: msg.senderRole, content: msg.content, messageType: msg.messageType || 'TEXT',
      timestamp: msg.timestamp.toISOString(), isSystemMessage: msg.isSystemMessage || false,
      deliveryStatus: msg.deliveryStatus || 'SENT',
      callLogData: msg.callLogData ? { event: msg.callLogData.event, durationSeconds: msg.callLogData.durationSeconds, callId: msg.callLogData.callId } : null,
    }));

    return res.json({ success: true, chat, messages: transformed, expiresAt: chat.expiresAt, isExpired: chat.isExpired() });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load messages.' });
  }
});

// ── SEND MESSAGE ──────────────────────────────────────────────────────────────
router.post('/chats/:chatId/messages', authenticate, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found.' });
    if (!chat.isParticipant(req.userId)) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (chat.isExpired()) return res.status(410).json({ success: false, message: 'Chat has expired.' });
    if (!req.body.content?.trim()) return res.status(400).json({ success: false, message: 'Message content required.' });

    const message = await Message.create({
      chatId: req.params.chatId, senderId: req.userId, senderRole: 'USER',
      content: req.body.content.trim(), messageType: req.body.messageType || 'TEXT', deliveryStatus: 'SENT',
    });
    await message.populate('senderId', 'firstName lastName profilePhoto');
    chat.lastMessageAt = new Date(); await chat.save();

    const payload = {
      _id: message._id.toString(), chatId: message.chatId.toString(),
      senderId: message.senderId._id.toString(),
      senderIdRaw: { _id: message.senderId._id.toString(), firstName: message.senderId.firstName, lastName: message.senderId.lastName, profilePhoto: message.senderId.profilePhoto },
      senderRole: message.senderRole, content: message.content, messageType: message.messageType,
      timestamp: message.timestamp.toISOString(), isSystemMessage: false, deliveryStatus: 'SENT',
    };
    const io = req.app.get('io');
    if (io) io.to(req.params.chatId).emit('new-message', payload);

    // ── FCM push to recipient ────────────────────────────────────────────────────
    // Always sent — no isUserOnline guard.
    // Reason: Socket.IO pingTimeout is 90s, so the server thinks the user is ONLINE
    // for up to 90 seconds after the app is killed. Guarding on isUserOnline blocks
    // FCM during that entire window.
    // Android side suppresses the notification if the chat screen is currently open
    // (activeForegroundChatId check in HumrahFirebaseMessagingService).
    try {
      const recipientParticipant = chat.participants.find(
        p => p.userId.toString() !== req.userId.toString()
      );
      if (recipientParticipant) {
        const recipientId = recipientParticipant.userId.toString();
        const { sendDataFcm } = require('../utils/fcmHelper');
        const [recipient, sender] = await Promise.all([
          User.findById(recipientId).select('fcmTokens firstName'),
          User.findById(req.userId).select('firstName profilePhoto'),
        ]);
        console.log(`[FCM] chat message push | recipientId=${recipientId} | tokenCount=${recipient?.fcmTokens?.length ?? 0}`);
        if (recipient?.fcmTokens?.length > 0) {
          sendDataFcm(recipientId, recipient.fcmTokens, {
            type:            'NEW_CHAT_MESSAGE',
            chatId:          req.params.chatId,
            chatType:        'RANDOM_BOOKING',
            senderName:      sender?.firstName ?? 'Someone',
            senderPhotoUrl:  sender?.profilePhoto ?? '',
            senderId:        req.userId.toString(),
            messageText:     req.body.content.trim().substring(0, 100),
            messageId:       message._id.toString(),
            recipientUserId: recipientId,
          }).catch(err => console.error('[FCM] chat msg push error:', err.message));
        }
      }
    } catch (fcmErr) {
      console.error('[FCM] chat msg error:', fcmErr.message);
    }

    return res.status(201).json({ success: true, message: payload });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to send message.' });
  }
});

// ── CALL LOG ──────────────────────────────────────────────────────────────────
router.post('/chats/:chatId/call-log', authenticate, async (req, res) => {
  try {
    const { event, durationSeconds = 0, callId = '' } = req.body;
    const VALID = ['started','ended','missed','rejected','cancelled'];
    if (!VALID.includes(event)) return res.status(400).json({ success: false, message: `event must be one of: ${VALID.join(', ')}` });

    const chat = await RandomBookingChat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found.' });
    if (!chat.isParticipant(req.userId)) return res.status(403).json({ success: false, message: 'Access denied.' });

    // BUG FIX 1 (server-side safety net): prevent duplicate call log entries.
    // Root cause on Android: both endCall() and handleRemoteHangup() wrote a log entry.
    // Fixed in Android, but this guard ensures only ONE entry per callId+event even if
    // the Android fix ever regresses. 'ended' and 'cancelled' are treated as the same
    // end-state so both are blocked if either already exists for this callId.
    if (callId) {
      const dupQuery = {
        chatId:               req.params.chatId,
        messageType:          'CALL_LOG',
        'callLogData.callId': callId,
        'callLogData.event':  (event === 'ended' || event === 'cancelled')
                                ? { $in: ['ended', 'cancelled'] }
                                : event,
      };
      const existing = await Message.findOne(dupQuery).lean();
      if (existing) {
        console.log(`[CALL_LOG] Duplicate blocked callId=${callId} event=${event} chatId=${req.params.chatId} existingId=${existing._id}`);
        return res.status(200).json({
          success:      true,
          deduplicated: true,
          message:      { _id: existing._id.toString(), messageType: 'CALL_LOG', content: existing.content, callLogData: existing.callLogData, timestamp: existing.timestamp.toISOString() }
        });
      }
    }

    const m = Math.floor(durationSeconds / 60), s = durationSeconds % 60;
    const content = event === 'ended' ? `📞 Voice call ended • ${m > 0 ? `${m}m ${s}s` : `${s}s`}` :
      ({ started:'📞 Voice call started', missed:'❌ Missed voice call', rejected:'📵 Call rejected', cancelled:'📵 Call cancelled' }[event] || '📞 Voice call');

    const message = await Message.create({
      chatId: req.params.chatId, senderId: req.userId, senderRole: 'USER',
      content, messageType: 'CALL_LOG', isSystemMessage: true, deliveryStatus: 'SENT',
      callLogData: { event, durationSeconds: Number(durationSeconds) || 0, callId: callId || '' },
    });
    chat.lastMessageAt = new Date(); await chat.save();

    const io = req.app.get('io');
    if (io) io.to(req.params.chatId).emit('new-message', { _id: message._id.toString(), chatId: message.chatId.toString(), senderId: message.senderId.toString(), content, messageType: 'CALL_LOG', timestamp: message.timestamp.toISOString(), isSystemMessage: true, deliveryStatus: 'SENT', callLogData: message.callLogData });
    return res.status(201).json({ success: true, message: { _id: message._id.toString(), messageType: 'CALL_LOG', content, callLogData: message.callLogData, timestamp: message.timestamp.toISOString() } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to save call log.' });
  }
});

// ── REPORT USER ───────────────────────────────────────────────────────────────
router.post('/chats/:chatId/report', authenticate, async (req, res) => {
  try {
    const chat = await RandomBookingChat.findById(req.params.chatId);
    if (!chat || !chat.isParticipant(req.userId) || chat.isDeleted) return res.status(404).json({ success: false, message: 'Chat not found or access denied.' });
    const { category, description } = req.body;
    if (!category || !description) return res.status(400).json({ success: false, message: 'Category and description required.' });
    const other = chat.participants.find(p => p.userId.toString() !== req.userId);
    if (!other) return res.status(400).json({ success: false, message: 'Other user not found.' });
    const SafetyReport = require('../models/SafetyReport');
    const report = await SafetyReport.create({ reporterId: req.userId, reportedUserId: other.userId, category, description, relatedBookingId: chat.bookingId, priority: 'HIGH', status: 'PENDING' });
    await chat.flagForReview(report._id);
    return res.json({ success: true, message: 'Report submitted.', reportId: report._id });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to submit report.' });
  }
});

// ── MY BOOKINGS ───────────────────────────────────────────────────────────────
router.get('/my-bookings', authenticate, async (req, res) => {
  try {
    const bookings = await RandomBooking.find({ initiatorId: req.userId }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, bookings });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load bookings.' });
  }
});

// ── USAGE ─────────────────────────────────────────────────────────────────────
router.get('/usage', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('random_trial_used');
    return res.json({ success: true, canCreateBooking: !user.random_trial_used, trialUsed: user.random_trial_used || false });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load usage.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PARAM ROUTES — /:bookingId and below — must come LAST
// ══════════════════════════════════════════════════════════════════════════════

// ── GET SINGLE BOOKING ────────────────────────────────────────────────────────
router.get('/:bookingId', authenticate, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId)
      .populate('initiatorId', 'firstName lastName profilePhoto verified questionnaire').lean();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

    const callerId    = req.userId.toString();
    const isInitiator = booking.initiatorId._id.toString() === callerId;
    const cur         = booking.candidateQueue?.[booking.currentCandidateIndex];
    const isCurrentCand = cur?.userId?.toString() === callerId;

    if (!isInitiator && !isCurrentCand && booking.status !== 'MATCHED') {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const shouldBlur = booking.blurProfileUntilAccepted && !isInitiator && booking.status !== 'MATCHED';
    const initiator  = { ...booking.initiatorId };
    if (shouldBlur) { initiator.profilePhoto = null; initiator.blurred = true; }

    return res.json({ success: true, booking: {
      _id: booking._id, status: booking.status, city: booking.city,
      meetupEnergy: booking.meetupEnergy || [], blurProfileUntilAccepted: booking.blurProfileUntilAccepted,
      startTime: booking.startTime, endTime: booking.endTime, reservedUntil: booking.reservedUntil,
      chatId: booking.chatId,
      matchSearchLocation: booking.matchSearchLocation
        ? { city: booking.matchSearchLocation.city, state: booking.matchSearchLocation.state }
        : null,
      initiatorId: initiator,
    }});
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load booking.' });
  }
});

// ── REVIEW RESERVE ────────────────────────────────────────────────────────────
router.post('/:bookingId/review-reserve', authenticate, async (req, res) => {
  try {
    console.log(`[/review-reserve] bookingId=${req.params.bookingId} userId=${req.userId}`);
    const { reserveForReview } = require('../utils/surpriseMeetupMatcher');
    const result = await reserveForReview(req.params.bookingId, req.userId);
    if (!result.ok) {
      const msgs = { not_found:'Booking not found.', not_available:'No longer available.', not_your_turn:"This request wasn't sent to you." };
      console.log(`[/review-reserve] FAIL reason=${result.reason}`);
      return res.status(400).json({ success: false, message: msgs[result.reason] || 'Could not reserve.' });
    }
    console.log(`[/review-reserve] OK reviewingUntil=${result.reviewingUntil}`);
    return res.json({ success: true, reviewingUntil: result.reviewingUntil });
  } catch (err) {
    console.error('[/review-reserve] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to reserve.' });
  }
});

// ── RESPOND (sequential accept/reject) ───────────────────────────────────────
router.post('/:bookingId/respond', authenticate, async (req, res) => {
  try {
    const { response, lat, lng, locationUpdatedAt } = req.body;
    if (!['ACCEPTED','REJECTED'].includes(response)) return res.status(400).json({ success: false, message: 'response must be ACCEPTED or REJECTED.' });

    // ── LOCATION SAFETY: require valid GPS when accepting ─────────────────────
    if (response === 'ACCEPTED') {
      if (lat == null || lng == null || lat === '' || lng === '') {
        return res.status(400).json({
          success: false,
          message: 'GPS location required to accept. Enable location services and try again.',
          code: 'LOCATION_REQUIRED'
        });
      }
      const numLat = Number(lat), numLng = Number(lng);
      if (isNaN(numLat) || isNaN(numLng) || numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
        return res.status(400).json({ success: false, message: 'Invalid GPS coordinates.', code: 'INVALID_LOCATION' });
      }
      // Freshness check — reject if location is older than 15 minutes
      if (locationUpdatedAt) {
        const ageMs = Date.now() - new Date(locationUpdatedAt).getTime();
        if (ageMs > 15 * 60 * 1000) {
          return res.status(400).json({
            success: false,
            message: 'Location is too old. Please refresh GPS and try again.',
            code: 'LOCATION_STALE'
          });
        }
      }
      // Update user’s live location with fresh coordinates from accept action
      await User.findByIdAndUpdate(req.userId, {
        $set: {
          'liveLocation.lat':       numLat,
          'liveLocation.lng':       numLng,
          'liveLocation.updatedAt': new Date(),
          last_known_lat:           numLat,
          last_known_lng:           numLng,
          last_location_updated_at: new Date(),
        }
      });
    }
    // ── end location check ────────────────────────────────────────────────────

    const user = await User.findById(req.userId).select('verified photoVerificationStatus');
    if (user.verified !== true && user.photoVerificationStatus !== 'approved') {
      return res.status(403).json({ success: false, message: 'Only verified users can respond.' });
    }

    const { handleCandidateResponse } = require('../utils/surpriseMeetupMatcher');
    const result = await handleCandidateResponse(req.params.bookingId, req.userId, response);
    if (!result.ok) {
      const msgs = { not_found:'Booking not found.', not_available:'No longer available.', not_your_turn:"Request wasn't sent to you.", already_responded:'Already responded.', invalid_response:'Invalid response.' };
      return res.status(400).json({ success: false, message: msgs[result.reason] || 'Could not process.' });
    }
    if (result.matched) {
      // ✅ Also emit websocket to the acceptor so the review screen navigates immediately
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${req.userId}`).emit('surprise_meetup_matched', {
          bookingId: req.params.bookingId,
          chatId:    result.chatId?.toString(),
        });
      }
      console.log(`[/respond] MATCHED bookingId=${req.params.bookingId} chatId=${result.chatId}`);
      return res.json({ success: true, matched: true, message: "You're matched! Chat is open.", chatId: result.chatId?.toString() });
    }
    return res.json({ success: true, matched: false, message: 'Passed on this one.' });
  } catch (err) {
    console.error('[/respond] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to process response.' });
  }
});

// ── ACCEPT (legacy) ───────────────────────────────────────────────────────────
router.post('/:bookingId/accept', authenticate, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ success: false, message: 'GPS location required.' });

    const user = await User.findById(req.userId).select('verified photoVerificationStatus');
    if (user.verified !== true && user.photoVerificationStatus !== 'approved') {
      return res.status(403).json({ success: false, message: 'Only verified users can accept.' });
    }

    const booking = await RandomBooking.findOneAndUpdate(
      { _id: req.params.bookingId, status: 'PENDING', expiresAt: { $gt: new Date() } },
      { status: 'MATCHED', acceptorId: req.userId, matchedAt: new Date() },
      { new: true }
    ).populate('initiatorId', 'firstName lastName profilePhoto');

    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found or no longer available.' });
    if (booking.initiatorId._id.toString() === req.userId) {
      booking.status = 'PENDING'; booking.acceptorId = null; booking.matchedAt = null;
      await booking.save();
      return res.status(400).json({ success: false, message: 'Cannot accept your own booking.' });
    }

    // Distance check uses frozen matchSearchLocation if present
    const bLat = booking.matchSearchLocation?.lat ?? booking.lat;
    const bLng = booking.matchSearchLocation?.lng ?? booking.lng;
    const dist = calculateDistance(lat, lng, bLat, bLng);
    if (dist > 20) {
      booking.status = 'PENDING'; booking.acceptorId = null; booking.matchedAt = null;
      await booking.save();
      return res.status(400).json({ success: false, message: 'Too far from booking location.' });
    }

    // Update acceptor's liveLocation and legacy fields
    await User.findByIdAndUpdate(req.userId, {
      $set: {
        last_known_lat:           Number(lat),
        last_known_lng:           Number(lng),
        last_location_updated_at: new Date(),
        'liveLocation.lat':       Number(lat),
        'liveLocation.lng':       Number(lng),
        'liveLocation.updatedAt': new Date(),
      }
    });

    await BookingMatch.create({ bookingId: booking._id, initiatorId: booking.initiatorId._id, acceptorId: req.userId, matchedAt: new Date() });
    const chat = await RandomBookingChat.createForBooking(booking);
    booking.chatId = chat._id; await booking.save();

    try {
      const { notifyBookingMatched } = require('../utils/progressiveMatching');
      const acceptor = await User.findById(req.userId).select('firstName lastName profilePhoto');
      await notifyBookingMatched(booking, acceptor);
    } catch(_) {}

    return res.json({ success: true, message: 'Booking accepted! Chat is open.', chatId: chat._id.toString(), booking: { _id: booking._id, status: booking.status, startTime: booking.startTime, endTime: booking.endTime } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to accept booking.' });
  }
});

// ── CANCEL ────────────────────────────────────────────────────────────────────
router.post('/:bookingId/cancel', authenticate, async (req, res) => {
  try {
    const booking = await RandomBooking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (booking.initiatorId.toString() !== req.userId) return res.status(403).json({ success: false, message: 'Only the creator can cancel.' });
    if (!['PENDING','SEARCHING','RESERVED'].includes(booking.status)) return res.status(400).json({ success: false, message: 'Cannot cancel a matched booking.' });
    booking.status = 'CANCELLED'; booking.cancelledAt = new Date(); booking.cancellationReason = req.body.reason || 'User cancelled';
    await booking.save();
    await User.findByIdAndUpdate(req.userId, { $inc: { 'behaviorMetrics.cancellationCount': 1 } });
    return res.json({ success: true, message: 'Booking cancelled.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to cancel booking.' });
  }
});

// ── COMPLETE ──────────────────────────────────────────────────────────────────
router.post('/:bookingId/complete', authenticate, async (req, res) => {
  try {
    const booking = await RandomBooking.findOneAndUpdate(
      { _id: req.params.bookingId, status: 'MATCHED', $or: [{ initiatorId: req.userId }, { acceptorId: req.userId }] },
      { status: 'COMPLETED', completedAt: new Date() }, { new: true }
    );
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to complete booking.' });
  }
});

module.exports = router;
