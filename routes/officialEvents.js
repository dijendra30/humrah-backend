const express = require('express');
const router = express.Router();
const OfficialEvent = require('../models/OfficialEvent');
const EventTicket   = require('../models/EventTicket');   // ✅ Ticket system
const User = require('../models/User');
const admin = require('../config/firebase');
const { auth, adminOnly } = require('../middleware/auth');
const { uploadBase64 } = require('../config/cloudinary');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function normalizeStr(str) {
  return str && typeof str === 'string' ? str.trim().toLowerCase() : str;
}

function normalizeLocationFields(body) {
  if (body.city) body.city = normalizeStr(body.city);
  if (body.district) body.district = normalizeStr(body.district);
  if (body.state) body.state = normalizeStr(body.state);
  if (body.country) body.country = normalizeStr(body.country);

  if (body.geographicTargeting) {
    if (body.geographicTargeting.state) body.geographicTargeting.state = normalizeStr(body.geographicTargeting.state);
    if (body.geographicTargeting.district) body.geographicTargeting.district = normalizeStr(body.geographicTargeting.district);
  }
}

function validateLocationFields(body) {
  if (body.isManualLocation === false) {
    const hasLat = body.latitude !== undefined && body.latitude !== null;
    const hasLng = body.longitude !== undefined && body.longitude !== null;
    const hasCoords = Array.isArray(body.coordinates) && body.coordinates.length === 2;
    if (!body.venueName || !body.state || !body.country || !body.placeId || !hasLat || !hasLng || !hasCoords) {
      return 'Google Places Location (venueName, state, country, latitude, longitude, coordinates, placeId) is required unless Manual Mode is enabled.';
    }
  }
  return null;
}

/** Build the Mongo query that enforces all targeting rules for a given user. */
function buildUserFeedQuery(user, extras = {}) {
  const now = new Date();
  const userState = user.questionnaire?.state || user.state;
  const userCity  = user.questionnaire?.city  || user.city;
  const userAge   = user.questionnaire?.age;
  const userGender = user.questionnaire?.gender;
  const profileCompletion = user.profileCompletion || 0;
  const isVerified = user.photoVerificationStatus === 'approved';

  const activeWindow = {
    status: 'Published',
    showOnApp: { $ne: false },
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: now } }
    ]
  };

  if (!isVerified) activeWindow.visibility = 'All Users';

  const audienceOr = [{ targetAudience: 'Everyone' }];
  if (isVerified) audienceOr.push({ targetAudience: 'Verified Users Only' });
  if (profileCompletion >= 70) audienceOr.push({ targetAudience: 'Profile Completion > 70%' });
  if (profileCompletion >= 90) audienceOr.push({ targetAudience: 'Profile Completion > 90%' });

  const cf = {
    targetAudience: 'Custom Filter',
    'customFilters.minProfileCompletion': { $lte: profileCompletion }
  };
  if (userGender) cf['customFilters.gender'] = { $in: [userGender, 'All'] };
  if (userAge) {
    const ageRanges = ['Any'];
    if (userAge >= 18 && userAge <= 24) ageRanges.push('18-24');
    if (userAge >= 25 && userAge <= 30) ageRanges.push('25-30');
    if (userAge >= 31 && userAge <= 40) ageRanges.push('31-40');
    cf['customFilters.ageRange'] = { $in: ageRanges };
  }
  audienceOr.push(cf);

  const userStateNorm = normalizeStr(userState);
  const userCityNorm  = normalizeStr(userCity);

  const geoOr = [
    { 'geographicTargeting.level': 'Entire India' },
    { 
      'geographicTargeting.level': 'State', 
      'geographicTargeting.state': userStateNorm ? new RegExp(`^${userStateNorm}$`, 'i') : null 
    },
    {
      'geographicTargeting.level': 'State + District',
      'geographicTargeting.state': userStateNorm ? new RegExp(`^${userStateNorm}$`, 'i') : null,
      'geographicTargeting.district': userCityNorm ? new RegExp(`^${userCityNorm}$`, 'i') : null
    }
  ];

  return {
    ...activeWindow,
    ...extras,
    $and: [
      { $or: audienceOr },
      { $or: geoOr }
    ]
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// USER-FACING ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/official-events/feed
router.get('/feed', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const query = buildUserFeedQuery(user);
    const events = await OfficialEvent.find(query)
      .sort({ pinOnExplore: -1, featuredEvent: -1, date: 1 })
      .lean();

    res.json({ success: true, events });
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/official-events/explore
router.get('/explore', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const search = req.query.q?.trim();
    const extras = {};
    if (search) {
      extras.$or = [
        { title: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { venueName: { $regex: search, $options: 'i' } }
      ];
    }

    const query = buildUserFeedQuery(user, extras);
    const all = await OfficialEvent.find(query).lean();

    const userState = user.questionnaire?.state || user.state;
    const userCity  = user.questionnaire?.city  || user.city;

    const userStateNorm = normalizeStr(userState);
    const userCityNorm  = normalizeStr(userCity);

    const sortedByDate = [...all].sort((a, b) => new Date(a.date) - new Date(b.date));
    const sortedByPop  = [...all].sort((a, b) =>
      (b.joinedCount + b.viewsCount) - (a.joinedCount + a.viewsCount));

    const featured = all.filter(e => e.featuredEvent || e.pinOnExplore).slice(0, 10);
    const nearYou  = all.filter(e => {
      const eState = normalizeStr(e.geographicTargeting?.state);
      const eDist  = normalizeStr(e.geographicTargeting?.district);
      return (e.geographicTargeting?.level === 'State' && eState === userStateNorm) ||
             (e.geographicTargeting?.level === 'State + District' && eDist === userCityNorm);
    }).slice(0, 15);

    res.json({
      success: true,
      featured,
      trending: sortedByPop.slice(0, 15),
      nearYou,
      upcoming: sortedByDate.slice(0, 20),
      allEvents: all
    });
  } catch (err) {
    console.error('Explore error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/official-events/:id/view
router.post('/:id/view', auth, async (req, res) => {
  try {
    await OfficialEvent.findByIdAndUpdate(req.params.id, { $inc: { viewsCount: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// POST /api/official-events/:id/join
router.post('/:id/join', auth, async (req, res) => {
  try {
    const event = await OfficialEvent.findById(req.params.id);
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    if (event.status !== 'Published') return res.status(400).json({ success: false, message: 'Event not available' });

    const userId = req.userId;

    // Temporarily block paid events
    if (event.eventPriceType === 'Paid') {
      console.log(`[EVENT JOIN FAILED] reason=Paid events blocked eventId=${event._id} userId=${userId}`);
      return res.status(400).json({ success: false, message: 'Online booking for paid events is coming soon' });
    }

    if (event.registrationDeadline && new Date() > event.registrationDeadline) {
      return res.status(400).json({ success: false, message: 'Registration deadline has passed' });
    }

    const user = await User.findById(userId).select('fcmToken fcmTokens questionnaire state city profileCompletion photoVerificationStatus').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { canUserJoinEvent } = require('../helpers/eventEligibility');
    if (!canUserJoinEvent(user, event)) {
      console.log(`[EVENT JOIN FAILED] reason=Ineligible eventId=${event._id} userId=${userId}`);
      return res.status(403).json({ success: false, message: 'You are not eligible for this event' });
    }

    // Atomic join logic
    const updatedEvent = await OfficialEvent.findOneAndUpdate({
      _id: event._id,
      joinedUsers: { $ne: userId },
      $or: [
        { unlimitedSeats: true },
        { $expr: { $lt: ["$joinedCount", "$capacity"] } }
      ]
    }, {
      $addToSet: { joinedUsers: userId },
      $inc: { joinedCount: 1 }
    }, { new: true });

    if (!updatedEvent) {
      // Check why it failed
      const currentEvent = await OfficialEvent.findById(event._id);
      if (currentEvent.joinedUsers.includes(userId)) {
        return res.status(400).json({ success: false, message: 'Already joined' });
      }

      // Event is full, handle waitlist
      if (currentEvent.waitlistEnabled) {
         if (!currentEvent.waitlistedUsers.includes(userId)) {
           // Atomic waitlist update
           await OfficialEvent.updateOne(
             { _id: event._id, waitlistedUsers: { $ne: userId } },
             { $addToSet: { waitlistedUsers: userId }, $inc: { waitlistCount: 1 } }
           );
           console.log(`[WAITLIST ADDED] eventId=${event._id} userId=${userId}`);
           return res.json({ success: true, waitlisted: true, message: 'Added to waitlist' });
         }
         return res.status(400).json({ success: false, message: 'Already on waitlist' });
      }

      console.log(`[EVENT JOIN FAILED] reason=Full eventId=${event._id} userId=${userId}`);
      return res.status(400).json({ success: false, message: 'Event is full' });
    }

    // Update state/district participation counts (non-atomic but low risk)
    const userState = user.questionnaire?.state || user.state || 'Unknown';
    const userDistrict = user.questionnaire?.city || user.city || 'Unknown';
    if (!updatedEvent.stateWiseParticipation) updatedEvent.stateWiseParticipation = new Map();
    if (!updatedEvent.districtWiseParticipation) updatedEvent.districtWiseParticipation = new Map();
    
    updatedEvent.stateWiseParticipation.set(userState, (updatedEvent.stateWiseParticipation.get(userState) || 0) + 1);
    updatedEvent.districtWiseParticipation.set(userDistrict, (updatedEvent.districtWiseParticipation.get(userDistrict) || 0) + 1);
    
    if (updatedEvent.autoCloseRegistration && !updatedEvent.unlimitedSeats &&
        updatedEvent.capacity && updatedEvent.joinedCount >= updatedEvent.capacity) {
      updatedEvent.registrationDeadline = new Date();
    }
    await updatedEvent.save();

    // ── Auto-generate ticket on join (idempotent) ──────────────────────────
    try {
      await EventTicket.findOneAndUpdate(
        { eventId: event._id, userId },
        { 
          $set: { status: 'active' }, 
          $setOnInsert: { eventId: event._id, userId } 
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (ticketErr) {
      console.error('[Ticket] Auto-generate error (non-fatal):', ticketErr.message);
    }

    console.log(`[EVENT JOIN SUCCESS] eventId=${event._id} userId=${userId}`);

    // Push notification (failure shouldn't break join)
    try {
      const payload = {
        notification: {
          title: 'Your Humrah ticket is ready 🎟️',
          body: `You successfully joined ${event.title}`
        },
        data: { type: 'official_event', eventId: event._id.toString() }
      };
      const fcmTokens = user.fcmTokens || [];
      if (fcmTokens.length > 0) {
        await admin.messaging().sendEachForMulticast({ ...payload, tokens: fcmTokens });
      } else if (user.fcmToken) {
        await admin.messaging().send({ ...payload, token: user.fcmToken });
      }
    } catch (fcmErr) {
      console.error('[FCM Error]:', fcmErr.message);
    }

    res.json({ success: true, message: 'Successfully joined the event!' });
  } catch (err) {
    console.error('Join error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/official-events/:id/leave
router.post('/:id/leave', auth, async (req, res) => {
  try {
    const eventId = req.params.id;
    const userId = req.userId;

    const event = await OfficialEvent.findById(eventId);
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });

    // Atomic leave from joinedUsers
    const leaveResult = await OfficialEvent.findOneAndUpdate(
      { _id: eventId, joinedUsers: userId, joinedCount: { $gt: 0 } },
      { 
        $pull: { joinedUsers: userId },
        $inc: { joinedCount: -1 } 
      },
      { new: true }
    );

    let wasJoined = !!leaveResult;
    let wasWaitlisted = false;

    if (!wasJoined) {
      // Try waitlist if user wasn't in joinedUsers
      const waitlistLeave = await OfficialEvent.findOneAndUpdate(
        { _id: eventId, waitlistedUsers: userId, waitlistCount: { $gt: 0 } },
        {
          $pull: { waitlistedUsers: userId },
          $inc: { waitlistCount: -1 }
        }
      );
      if (waitlistLeave) wasWaitlisted = true;
    }

    if (!wasJoined && !wasWaitlisted) {
      // It's possible joinedCount was 0 (shouldn't happen), or user just isn't there
      return res.status(400).json({ success: false, message: 'Not joined or on waitlist' });
    }

    // Waitlist promotion logic
    if (wasJoined && leaveResult.waitlistEnabled && leaveResult.waitlistedUsers.length > 0) {
      // Promote the first user
      const nextUser = leaveResult.waitlistedUsers[0];
      const promoteResult = await OfficialEvent.findOneAndUpdate(
        {
          _id: eventId,
          waitlistedUsers: nextUser,
          $or: [
            { unlimitedSeats: true },
            { $expr: { $lt: ["$joinedCount", "$capacity"] } }
          ]
        },
        {
          $pull: { waitlistedUsers: nextUser },
          $inc: { waitlistCount: -1, joinedCount: 1 },
          $addToSet: { joinedUsers: nextUser }
        },
        { new: true }
      );

      if (promoteResult) {
        console.log(`[WAITLIST PROMOTED] eventId=${eventId} userId=${nextUser}`);
        
        try {
          await EventTicket.findOneAndUpdate(
            { eventId: eventId, userId: nextUser },
            { 
              $set: { status: 'active' }, 
              $setOnInsert: { eventId: eventId, userId: nextUser } 
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
        } catch (e) {
          console.error('[Ticket Promote Error]:', e.message);
        }

        try {
          const promotedUser = await User.findById(nextUser).select('fcmTokens fcmToken').lean();
          if (promotedUser) {
            const payload = {
              notification: { 
                title: "You're in 🎉", 
                body: `A spot opened for ${promoteResult.title}. Your ticket is confirmed.` 
              },
              data: { type: 'official_event', eventId: eventId.toString() }
            };
            const fcmTokens = promotedUser.fcmTokens || [];
            if (fcmTokens.length > 0) {
              await admin.messaging().sendEachForMulticast({ ...payload, tokens: fcmTokens });
            } else if (promotedUser.fcmToken) {
              await admin.messaging().send({ ...payload, token: promotedUser.fcmToken });
            }
          }
        } catch (e) {
          console.error('[FCM Error Waitlist Promoted]:', e.message);
        }
      }
    }

    // Cancel ticket on leave
    await EventTicket.findOneAndUpdate(
      { eventId: eventId, userId: userId },
      { $set: { status: 'cancelled' } }
    );

    res.json({ success: true, message: 'Left event' });
  } catch (err) {
    console.error('Leave error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TICKET ROUTES — USER-FACING
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/official-events/my-tickets
router.get('/my-tickets', auth, async (req, res) => {
  try {
    const tickets = await EventTicket.find({ userId: req.userId })
      .populate({
         path: 'eventId',
         select: 'title bannerImage venueName date startTime status',
      })
      .lean();

    const upcomingTickets = [];
    const pastTickets = [];
    const cancelledTickets = [];
    
    const now = new Date();

    for (const t of tickets) {
       if (!t.eventId) continue; 

       if (t.status === 'cancelled') {
           cancelledTickets.push(t);
           continue;
       }
       
       const eventDate = new Date(t.eventId.date);
       if (t.eventId.status === 'Expired' || eventDate < now) {
           if (t.status === 'active' || t.status === 'used') {
               pastTickets.push(t);
           }
       } else {
           upcomingTickets.push(t);
       }
    }

    upcomingTickets.sort((a, b) => new Date(a.eventId.date) - new Date(b.eventId.date));
    pastTickets.sort((a, b) => new Date(b.eventId.date) - new Date(a.eventId.date));
    cancelledTickets.sort((a, b) => new Date(b.eventId.date) - new Date(a.eventId.date));

    res.json({
       success: true,
       upcomingTickets,
       pastTickets,
       cancelledTickets
    });
  } catch (err) {
    console.error('My-tickets error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/official-events/:id/my-ticket
// Returns (or lazily creates) the user's ticket for this event.
// Android uses ticketCode + qrData to render the QR code on the Ticket screen.
router.get('/:id/my-ticket', auth, async (req, res) => {
  try {
    const event = await OfficialEvent.findById(req.params.id).lean();
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });

    const isJoined = (event.joinedUsers || []).some(u => u.toString() === req.userId);
    if (!isJoined) {
      return res.status(403).json({ success: false, message: 'You have not joined this event' });
    }

    // Lazy-create if somehow missed during join
    let ticket = await EventTicket.findOne({ eventId: req.params.id, userId: req.userId });
    if (!ticket) {
      ticket = await EventTicket.create({ eventId: req.params.id, userId: req.userId });
    }

    res.json({
      success: true,
      ticket: {
        ticketCode:  ticket.ticketCode,
        qrData:      ticket.qrData,
        status:      ticket.status,
        issuedAt:    ticket.createdAt,
        checkedInAt: ticket.checkedInAt,
        event: {
          title:       event.title,
          date:        event.date,
          startTime:   event.startTime,
          endTime:     event.endTime,
          venueName:   event.venueName,
          fullAddress: event.fullAddress,
          city:        event.city,
          bannerImage: event.bannerImage,
          organizerName: event.organizerName,
          organizerLogo: event.organizerLogo,
        }
      }
    });
  } catch (err) {
    console.error('My-ticket error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET  /api/official-events/admin/events
router.get('/admin/events', auth, adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const events = await OfficialEvent.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET  /api/official-events/admin/events/:id
router.get('/admin/events/:id', auth, adminOnly, async (req, res) => {
  try {
    const event = await OfficialEvent.findById(req.params.id).lean();
    if (!event) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, event });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET  /api/official-events/admin/events/:id/registrations
router.get('/admin/events/:id/registrations', auth, adminOnly, async (req, res) => {
  try {
    const event = await OfficialEvent
      .findById(req.params.id)
      .populate('joinedUsers', 'firstName lastName email profilePhoto questionnaire city state profileCompletion photoVerificationStatus createdAt')
      .populate('waitlistedUsers', 'firstName lastName email profilePhoto questionnaire city state profileCompletion photoVerificationStatus createdAt')
      .lean();

    if (!event) return res.status(404).json({ success: false, message: 'Not found' });

    res.json({
      success: true,
      eventTitle: event.title,
      joinedCount: event.joinedCount,
      waitlistCount: event.waitlistCount,
      capacity: event.capacity,
      unlimitedSeats: event.unlimitedSeats,
      registrations: event.joinedUsers || [],
      waitlist: event.waitlistedUsers || []
    });
  } catch (err) {
    console.error('Registrations error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/official-events/admin/events/:id/export-attendees
router.get('/admin/events/:id/export-attendees', auth, adminOnly, async (req, res) => {
  try {
    const tickets = await EventTicket.find({ eventId: req.params.id })
      .populate('userId', 'firstName lastName email phone')
      .lean();

    const escapeCSV = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val);
      return `"${str.replace(/"/g, '""')}"`;
    };

    const header = ['Name', 'Email', 'Phone', 'Ticket ID', 'Join Date', 'Ticket Status', 'Check-in Status'].join(',');
    const rows = [header];

    for (const t of tickets) {
      if (!t.userId) continue;
      const name = `${t.userId.firstName || ''} ${t.userId.lastName || ''}`.trim();
      const email = t.userId.email || '';
      const phone = t.userId.phone || ''; 
      const joinDate = t.createdAt ? new Date(t.createdAt).toISOString() : '';
      const checkInStatus = t.status === 'used' ? 'Checked In' : (t.status === 'active' ? 'Not Checked In' : 'Cancelled');
      
      const row = [
        escapeCSV(name),
        escapeCSV(email),
        escapeCSV(phone),
        escapeCSV(t.ticketCode),
        escapeCSV(joinDate),
        escapeCSV(t.status),
        escapeCSV(checkInStatus)
      ].join(',');
      rows.push(row);
    }

    const csvData = rows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendees_${req.params.id}.csv"`);
    res.send(csvData);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/official-events/admin/events/:id/registrations/:userId
router.delete('/admin/events/:id/registrations/:userId', auth, adminOnly, async (req, res) => {
  try {
    const event = await OfficialEvent.findById(req.params.id);
    if (!event) return res.status(404).json({ success: false, message: 'Not found' });

    const uid = req.params.userId;
    const wasJoined = event.joinedUsers.some(u => u.toString() === uid);
    const wasWaited = event.waitlistedUsers.some(u => u.toString() === uid);

    event.joinedUsers      = event.joinedUsers.filter(u => u.toString() !== uid);
    event.waitlistedUsers  = event.waitlistedUsers.filter(u => u.toString() !== uid);
    if (wasJoined) event.joinedCount   = Math.max(0, event.joinedCount - 1);
    if (wasWaited) event.waitlistCount = Math.max(0, event.waitlistCount - 1);

    await event.save();

    // Also cancel their ticket
    await EventTicket.findOneAndUpdate(
      { eventId: req.params.id, userId: uid },
      { $set: { status: 'cancelled' } }
    );

    res.json({ success: true, message: 'Registration removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/official-events/admin/analytics
router.get('/admin/analytics', auth, adminOnly, async (req, res) => {
  try {
    const all = await OfficialEvent.find().lean();
    const published = all.filter(e => e.status === 'Published');

    const totalViews  = all.reduce((s, e) => s + (e.viewsCount  || 0), 0);
    const totalJoins  = all.reduce((s, e) => s + (e.joinedCount || 0), 0);
    const totalNotifs = all.reduce((s, e) => s + (e.notificationsSent || 0), 0);
    const conversionRate = totalViews > 0 ? +((totalJoins / totalViews) * 100).toFixed(1) : 0;

    const byCategory = {};
    all.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + (e.joinedCount || 0); });

    const byStatus = { Draft: 0, Published: 0, Scheduled: 0, Expired: 0, Cancelled: 0 };
    all.forEach(e => { byStatus[e.status] = (byStatus[e.status] || 0) + 1; });

    const stateWise = {};
    all.forEach(e => {
      if (e.stateWiseParticipation) {
        Object.entries(e.stateWiseParticipation).forEach(([s, n]) => {
          stateWise[s] = (stateWise[s] || 0) + n;
        });
      }
    });

    res.json({
      success: true,
      summary: { totalViews, totalJoins, totalNotifs, conversionRate },
      byCategory,
      byStatus,
      stateWise,
      topEvents: published
        .sort((a, b) => b.joinedCount - a.joinedCount)
        .slice(0, 10)
        .map(e => ({
          _id: e._id, title: e.title, category: e.category,
          joinedCount: e.joinedCount, viewsCount: e.viewsCount,
          notificationsSent: e.notificationsSent, date: e.date
        }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/official-events/admin/events
router.post('/admin/events', auth, adminOnly, async (req, res) => {
  try {
    const body = { ...req.body };

    const locError = validateLocationFields(body);
    if (locError) return res.status(400).json({ success: false, message: locError });

    normalizeLocationFields(body);

    if (body.bannerImageBase64) {
      const r = await uploadBase64(body.bannerImageBase64, 'humrah/events/banners');
      body.bannerImage = r.url;
      delete body.bannerImageBase64;
    }

    if (body.organizerLogoBase64) {
      const r = await uploadBase64(body.organizerLogoBase64, 'humrah/events/organizers');
      body.organizerLogo = r.url;
      delete body.organizerLogoBase64;
    }

    body.galleryImages = [];
    if (Array.isArray(body.galleryImagesBase64)) {
      for (const b64 of body.galleryImagesBase64) {
        const r = await uploadBase64(b64, 'humrah/events/gallery');
        body.galleryImages.push(r.url);
      }
      delete body.galleryImagesBase64;
    }

    if (body.pinOnExplore !== undefined) body.featureOnExplore = body.pinOnExplore;

    const event = new OfficialEvent({ ...body, createdBy: req.userId });
    await event.save();

    res.status(201).json({ success: true, event });

    if (event.status === 'Published' && body.sendNotification) {
      sendEventNotifications(event).catch(err => console.error('FCM error:', err));
    }
  } catch (error) {
    console.error("Official Event Create Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV !== "production" ? error.stack : undefined
    });
  }
});

// PUT /api/official-events/admin/events/:id
router.put('/admin/events/:id', auth, adminOnly, async (req, res) => {
  try {
    const old = await OfficialEvent.findById(req.params.id);
    if (!old) return res.status(404).json({ success: false, message: 'Not found' });

    const body = { ...req.body };

    const locError = validateLocationFields(body);
    if (locError) return res.status(400).json({ success: false, message: locError });

    normalizeLocationFields(body);

    if (body.bannerImageBase64) {
      const r = await uploadBase64(body.bannerImageBase64, 'humrah/events/banners');
      body.bannerImage = r.url;
      delete body.bannerImageBase64;
    }

    if (body.organizerLogoBase64) {
      const r = await uploadBase64(body.organizerLogoBase64, 'humrah/events/organizers');
      body.organizerLogo = r.url;
      delete body.organizerLogoBase64;
    }

    if (Array.isArray(body.galleryImagesBase64) && body.galleryImagesBase64.length > 0) {
      const existing = body.galleryImages || [];
      for (const b64 of body.galleryImagesBase64) {
        const r = await uploadBase64(b64, 'humrah/events/gallery');
        existing.push(r.url);
      }
      body.galleryImages = existing;
      delete body.galleryImagesBase64;
    }

    if (body.pinOnExplore !== undefined) body.featureOnExplore = body.pinOnExplore;

    const updated = await OfficialEvent.findByIdAndUpdate(req.params.id, body, { new: true });
    res.json({ success: true, event: updated });

    if (old.status !== 'Published' && updated.status === 'Published' && body.sendNotification) {
      sendEventNotifications(updated).catch(err => console.error('FCM error:', err));
    }
  } catch (error) {
    console.error("Official Event Update Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      stack: process.env.NODE_ENV !== "production" ? error.stack : undefined
    });
  }
});

// DELETE /api/official-events/admin/events/:id
router.delete('/admin/events/:id', auth, adminOnly, async (req, res) => {
  try {
    await OfficialEvent.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TICKET ROUTES — ADMIN
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/official-events/admin/events/:id/tickets
// List every ticket issued for an event with live stats
router.get('/admin/events/:id/tickets', auth, adminOnly, async (req, res) => {
  try {
    const tickets = await EventTicket
      .find({ eventId: req.params.id })
      .populate('userId',      'firstName lastName email profilePhoto photoVerificationStatus')
      .populate('checkedInBy', 'firstName lastName')
      .sort({ createdAt: -1 })
      .lean();

    const stats = {
      total:     tickets.length,
      active:    tickets.filter(t => t.status === 'active').length,
      used:      tickets.filter(t => t.status === 'used').length,
      cancelled: tickets.filter(t => t.status === 'cancelled').length,
    };

    res.json({ success: true, tickets, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/official-events/admin/verify-ticket
// Scan a ticket at the door: validates + marks as used (check-in)
router.post('/admin/verify-ticket', auth, adminOnly, async (req, res) => {
  try {
    const { ticketCode } = req.body;
    if (!ticketCode?.trim()) {
      return res.status(400).json({ success: false, message: 'ticketCode is required' });
    }

    const ticket = await EventTicket
      .findOne({ ticketCode: ticketCode.trim().toUpperCase() })
      .populate('userId',  'firstName lastName email profilePhoto photoVerificationStatus questionnaire city state')
      .populate('eventId', 'title date startTime venueName city')
      .lean();

    if (!ticket) {
      return res.status(404).json({ success: false, valid: false, message: 'Ticket not found — invalid code' });
    }

    if (ticket.status === 'cancelled') {
      return res.json({ success: true, valid: false, cancelled: true, ticket: { ticketCode: ticket.ticketCode, status: 'cancelled' } });
    }

    if (ticket.status === 'used') {
      return res.json({
        success: true,
        valid: false,
        alreadyUsed: true,
        checkedInAt: ticket.checkedInAt,
        ticket: {
          ticketCode:  ticket.ticketCode,
          status:      'used',
          checkedInAt: ticket.checkedInAt,
          user:        ticket.userId,
          event:       ticket.eventId,
        }
      });
    }

    // ── Mark as used ──────────────────────────────────────────────────────────
    const checkedInAt = new Date();
    await EventTicket.findByIdAndUpdate(ticket._id, {
      $set: { status: 'used', checkedInAt, checkedInBy: req.userId }
    });

    res.json({
      success: true,
      valid: true,
      ticket: {
        ticketCode:  ticket.ticketCode,
        status:      'used',
        checkedInAt,
        user:        ticket.userId,
        event:       ticket.eventId,
      }
    });
  } catch (err) {
    console.error('Verify ticket error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/official-events/admin/tickets/:ticketId/cancel
// Admin force-cancel a single ticket
router.patch('/admin/tickets/:ticketId/cancel', auth, adminOnly, async (req, res) => {
  try {
    const ticket = await EventTicket.findByIdAndUpdate(
      req.params.ticketId,
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    res.json({ success: true, ticket });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FCM NOTIFICATIONS HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function sendEventNotifications(event) {
  if (!admin.apps.length) return;

  const query = { fcmToken: { $exists: true, $ne: null } };

  if (event.visibility === 'Verified Users Only') {
    query.photoVerificationStatus = 'approved';
  }

  switch (event.targetAudience) {
    case 'Verified Users Only':
      query.photoVerificationStatus = 'approved';
      break;
    case 'Profile Completion > 70%':
      query.profileCompletion = { $gte: 70 };
      break;
    case 'Profile Completion > 90%':
      query.profileCompletion = { $gte: 90 };
      break;
    case 'Custom Filter': {
      const cf = event.customFilters || {};
      if (cf.minProfileCompletion > 0)
        query.profileCompletion = { $gte: cf.minProfileCompletion };
      if (cf.gender && cf.gender !== 'All')
        query['questionnaire.gender'] = cf.gender;
      if (cf.ageRange && cf.ageRange !== 'Any') {
        if (cf.ageRange === '18-24') query['questionnaire.age'] = { $gte: 18, $lte: 24 };
        else if (cf.ageRange === '25-30') query['questionnaire.age'] = { $gte: 25, $lte: 30 };
        else if (cf.ageRange === '31-40') query['questionnaire.age'] = { $gte: 31, $lte: 40 };
        else if (cf.ageRange === 'Custom Range' && cf.minAge && cf.maxAge)
          query['questionnaire.age'] = { $gte: cf.minAge, $lte: cf.maxAge };
      }
      break;
    }
    default:
      break;
  }

  const geo = event.geographicTargeting || {};
  if (geo.level === 'State') {
    query['questionnaire.state'] = geo.state;
  } else if (geo.level === 'State + District') {
    query['questionnaire.state'] = geo.state;
    query['questionnaire.city']  = geo.district;
  }

  const users  = await User.find(query).select('fcmToken').lean();
  const tokens = users.map(u => u.fcmToken).filter(Boolean);
  if (!tokens.length) return;

  const notifTitle = geo.level === 'State + District'
    ? `🎉 New Event in ${geo.district}`
    : event.targetAudience === 'Verified Users Only'
      ? '🔒 Verified Members Event'
      : '🎉 New Event Near You';

  const notifBody = event.targetAudience === 'Verified Users Only'
    ? `A special event for verified members: ${event.title}`
    : `${event.title} — ${new Date(event.date).toLocaleDateString('en-IN')}`;

  const message = {
    notification: { title: notifTitle, body: notifBody, imageUrl: event.bannerImage },
    data: { type: 'official_event', eventId: event._id.toString() }
  };

  let successCount = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    try {
      const r = await admin.messaging().sendMulticast({ ...message, tokens: batch });
      successCount += r.successCount;
    } catch (e) {
      console.error('FCM batch error:', e);
    }
  }

  await OfficialEvent.findByIdAndUpdate(event._id, { $inc: { notificationsSent: successCount } });
  console.log(`Notifications sent: ${successCount}`);
}

module.exports = router;
