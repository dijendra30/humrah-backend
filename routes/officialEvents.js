const express = require('express');
const router = express.Router();
const OfficialEvent = require('../models/OfficialEvent');
const User = require('../models/User');
const admin = require('../config/firebase'); // For FCM

// Auth middleware (Assuming we have standard auth & adminOnly middleware)
const { auth, adminOnly } = require('../middleware/auth');

// ==========================================
// USER FACING APIS (STRICT ENFORCEMENT)
// ==========================================

router.get('/feed', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const now = new Date();

    // Base query for active, published events
    let query = {
      status: 'Published',
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: null },
        { expiresAt: { $gt: now } }
      ]
    };

    // --- ENFORCE VISIBILITY ---
    if (user.photoVerificationStatus !== 'approved') {
      // Unverified users can ONLY see 'All Users' events
      query.visibility = 'All Users';
    }

    // --- ENFORCE AUDIENCE ---
    let audienceConditions = [{ targetAudience: 'All Users' }];
    
    if (user.photoVerificationStatus === 'approved') {
      audienceConditions.push({ targetAudience: 'Verified Users Only' });
      // Add 'Hosts Only' or 'Members Only' logic here if applicable to your User model
      if (user.isCompanion || user.companionStatus === 'approved') {
        audienceConditions.push({ targetAudience: 'Hosts Only' });
      }
    }

    // Handle Custom Filters (if any events use it)
    const customFilterCondition = {
      targetAudience: 'Custom Filter',
      'customFilters.minProfileCompletion': { $lte: user.profileCompletion || 0 }
    };
    
    // Age check for custom filter
    if (user.questionnaire?.age) {
      const age = user.questionnaire.age;
      let ageMatch = [];
      if (age >= 18 && age <= 24) ageMatch.push('18-24');
      if (age >= 25 && age <= 30) ageMatch.push('25-30');
      if (age > 30) ageMatch.push('30+');
      ageMatch.push('Any');
      
      customFilterCondition['customFilters.ageRange'] = { $in: ageMatch };
    }

    // Gender check for custom filter
    if (user.questionnaire?.gender) {
      customFilterCondition['customFilters.gender'] = { $in: [user.questionnaire.gender, 'Everyone'] };
    }

    audienceConditions.push(customFilterCondition);
    query.$or = [{ $or: query.$or }, { $or: audienceConditions }]; // Merge constraints

    // --- ENFORCE GEOGRAPHY ---
    const userState = user.questionnaire?.state || user.state;
    const userCity = user.questionnaire?.city || user.city; // App uses city/area, mapping district to city
    
    query['$and'] = [
      {
        $or: query.$or.shift() // The expiresAt constraint
      },
      {
        $or: query.$or.shift() // The audience constraint
      },
      {
        $or: [
          { 'geographicTargeting.level': 'Entire India' },
          { 
            'geographicTargeting.level': 'State', 
            'geographicTargeting.state': userState 
          },
          { 
            'geographicTargeting.level': 'District', 
            'geographicTargeting.state': userState,
            'geographicTargeting.district': userCity // assuming district maps to city
          }
        ]
      }
    ];
    
    delete query.$or;

    const events = await OfficialEvent.find(query).sort({ featureOnExplore: -1, date: 1 });

    res.json({ success: true, events });
  } catch (error) {
    console.error('Fetch feed error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/:id/view', auth, async (req, res) => {
  try {
    await OfficialEvent.findByIdAndUpdate(req.params.id, { $inc: { viewsCount: 1 } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

router.post('/:id/join', auth, async (req, res) => {
  try {
    const event = await OfficialEvent.findById(req.params.id);
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    
    if (event.joinedUsers.includes(req.userId)) {
      return res.status(400).json({ success: false, message: 'Already joined' });
    }

    if (event.capacity && event.joinedCount >= event.capacity) {
      return res.status(400).json({ success: false, message: 'Event is full' });
    }

    const user = await User.findById(req.userId).select('questionnaire state city');
    const userState = user.questionnaire?.state || user.state || 'Unknown';
    const userDistrict = user.questionnaire?.city || user.city || 'Unknown';

    event.joinedUsers.push(req.userId);
    event.joinedCount += 1;
    
    // Update analytics
    if (!event.stateWiseParticipation) event.stateWiseParticipation = new Map();
    event.stateWiseParticipation.set(userState, (event.stateWiseParticipation.get(userState) || 0) + 1);

    if (!event.districtWiseParticipation) event.districtWiseParticipation = new Map();
    event.districtWiseParticipation.set(userDistrict, (event.districtWiseParticipation.get(userDistrict) || 0) + 1);

    await event.save();

    res.json({ success: true, message: 'Successfully joined the event!' });
  } catch (error) {
    console.error('Join event error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const { uploadBase64 } = require('../config/cloudinary');

// ==========================================
// ADMIN APIS
// ==========================================

router.get('/admin/events', auth, adminOnly, async (req, res) => {
  try {
    const events = await OfficialEvent.find().sort({ createdAt: -1 });
    res.json({ success: true, events });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/admin/events', auth, adminOnly, async (req, res) => {
  try {
    let bannerImageUrl = req.body.bannerImage || '';
    if (req.body.bannerImageBase64) {
      const uploadResult = await uploadBase64(req.body.bannerImageBase64, 'humrah/events');
      bannerImageUrl = uploadResult.url;
    }

    let galleryImageUrls = [];
    if (req.body.galleryImagesBase64 && Array.isArray(req.body.galleryImagesBase64)) {
      for (const b64 of req.body.galleryImagesBase64) {
        const result = await uploadBase64(b64, 'humrah/events');
        galleryImageUrls.push(result.url);
      }
    }

    const eventData = { ...req.body };
    delete eventData.bannerImageBase64;
    delete eventData.galleryImagesBase64;
    eventData.bannerImage = bannerImageUrl;
    eventData.galleryImages = galleryImageUrls;

    const newEvent = new OfficialEvent({
      ...eventData,
      createdBy: req.userId
    });
    
    await newEvent.save();

    res.status(201).json({ success: true, event: newEvent });

    // --- ASYNC FCM NOTIFICATIONS ---
    if (newEvent.status === 'Published' && req.body.sendNotification) {
      sendEventNotifications(newEvent).catch(err => console.error('FCM Job Error:', err));
    }

  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

router.put('/admin/events/:id', auth, adminOnly, async (req, res) => {
  try {
    const oldEvent = await OfficialEvent.findById(req.params.id);
    
    const eventData = { ...req.body };
    
    if (req.body.bannerImageBase64) {
      const uploadResult = await uploadBase64(req.body.bannerImageBase64, 'humrah/events');
      eventData.bannerImage = uploadResult.url;
      delete eventData.bannerImageBase64;
    }

    if (req.body.galleryImagesBase64 && Array.isArray(req.body.galleryImagesBase64)) {
      let galleryImageUrls = eventData.galleryImages || [];
      for (const b64 of req.body.galleryImagesBase64) {
        const result = await uploadBase64(b64, 'humrah/events');
        galleryImageUrls.push(result.url);
      }
      eventData.galleryImages = galleryImageUrls;
      delete eventData.galleryImagesBase64;
    }

    const updatedEvent = await OfficialEvent.findByIdAndUpdate(req.params.id, eventData, { new: true });
    
    res.json({ success: true, event: updatedEvent });

    // If it was just published
    if (oldEvent.status !== 'Published' && updatedEvent.status === 'Published' && req.body.sendNotification) {
      sendEventNotifications(updatedEvent).catch(err => console.error('FCM Job Error:', err));
    }

  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/admin/events/:id', auth, adminOnly, async (req, res) => {
  try {
    await OfficialEvent.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// ==========================================
// NOTIFICATION HELPER
// ==========================================

async function sendEventNotifications(event) {
  if (!admin.apps.length) return; // FCM not configured

  // Build the User query exactly matching the visibility and geographic targeting
  let query = { fcmToken: { $exists: true, $ne: null } };

  // Visibility
  if (event.visibility === 'Verified Users Only' || event.targetAudience === 'Verified Users Only') {
    query.photoVerificationStatus = 'approved';
  }

  // Geography
  if (event.geographicTargeting?.level === 'State') {
    query['questionnaire.state'] = event.geographicTargeting.state;
  } else if (event.geographicTargeting?.level === 'District') {
    query['questionnaire.state'] = event.geographicTargeting.state;
    query['questionnaire.city'] = event.geographicTargeting.district;
  }

  // Audience
  if (event.targetAudience === 'Custom Filter') {
    const filters = event.customFilters || {};
    if (filters.minProfileCompletion > 0) {
      query.profileCompletion = { $gte: filters.minProfileCompletion };
    }
    if (filters.gender && filters.gender !== 'Everyone') {
      query['questionnaire.gender'] = filters.gender;
    }
    // Age filtering would be complex in Mongo if age is dynamic, but we assume questionnaire.age is maintained
    if (filters.ageRange && filters.ageRange !== 'Any') {
       if (filters.ageRange === '18-24') query['questionnaire.age'] = { $gte: 18, $lte: 24 };
       if (filters.ageRange === '25-30') query['questionnaire.age'] = { $gte: 25, $lte: 30 };
       if (filters.ageRange === '30+') query['questionnaire.age'] = { $gte: 31 };
    }
  }

  // Fetch users
  const users = await User.find(query).select('fcmToken').lean();
  const tokens = users.map(u => u.fcmToken).filter(t => t);

  if (tokens.length === 0) return;

  // Build Payload
  let notificationTitle = "🎉 New Event Near You";
  let notificationBody = `${event.title} is happening on ${new Date(event.date).toLocaleDateString()}. Join now!`;

  if (event.targetAudience === 'Verified Users Only' || event.visibility === 'Verified Users Only') {
    notificationTitle = "🔒 Verified Members Event";
    notificationBody = `A special event is available exclusively for verified members: ${event.title}.`;
  } else if (event.geographicTargeting?.level === 'District') {
    notificationTitle = `🎉 New Event in ${event.geographicTargeting.district}`;
    notificationBody = `A new Humrah activity has been created near you.`;
  }

  const message = {
    notification: {
      title: notificationTitle,
      body: notificationBody,
      imageUrl: event.bannerImage
    },
    data: {
      type: 'official_event',
      eventId: event._id.toString()
    }
  };

  // Send in batches of 500
  let successCount = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const msg = { ...message, tokens: batch };
    try {
      const response = await admin.messaging().sendMulticast(msg);
      successCount += response.successCount;
    } catch (e) {
      console.error('FCM send error:', e);
    }
  }

  // Update analytics
  await OfficialEvent.findByIdAndUpdate(event._id, {
    $inc: { notificationsSent: successCount }
  });
}

module.exports = router;
