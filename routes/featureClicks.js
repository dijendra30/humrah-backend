// routes/featureClicks.js
// Logs "coming soon" feature click events from the Android app.
// Currently tracks: orphanage_click  (Visit Orphanage card on Home screen)
//
// Design goals:
//  - Always return HTTP 200 — tracking must NEVER crash or block the app
//  - userId comes from JWT (auth middleware) — never trusted from request body
//  - Name + email fetched server-side from User model so Android sends nothing sensitive
//  - Persists to MongoDB via OrphanageClick model

const express        = require('express');
const router         = express.Router();
const { auth }       = require('../middleware/auth');
const OrphanageClick = require('../models/OrphanageClick');
const User           = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/events/orphanage-click
//
// Body (all optional — designed to be resilient to missing fields):
//   {
//     "action"    : "orphanage_click",   // informational, ignored server-side
//     "timestamp" : "2025-05-03T...",    // client-side ISO timestamp
//     "source"    : "home_screen"
//   }
//
// Privacy: only minimal non-sensitive data stored.
//          Do NOT add device fingerprint, location, or contact info.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/orphanage-click', auth, async (req, res) => {
  try {
    const userId   = req.userId;                              // from verified JWT
    const source   = req.body.source    || 'home_screen';
    const deviceTs = req.body.timestamp || '';

    // Pull name + email from DB — Android doesn't send them, no exposure risk
    const user  = await User.findById(userId).select('firstName lastName email').lean();
    const name  = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '';
    const email = user?.email || '';

    await OrphanageClick.create({
      userId,
      name,
      email,
      source,
      deviceTs,
      action: 'orphanage_click'
    });

    console.log(`[FeatureClick] orphanage_click saved → userId=${userId} name="${name}" email="${email}"`);

    return res.status(200).json({ success: true, message: 'Event logged' });

  } catch (error) {
    // Swallow silently — tracking must never surface errors to the client
    console.error('[FeatureClick] Failed to save orphanage_click:', error.message);
    return res.status(200).json({ success: true, message: 'Event received' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/events/orphanage-clicks
// Admin inspection endpoint — returns last 100 records with full user details.
// TODO: replace `auth` with `adminOnly` middleware before production.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/orphanage-clicks', auth, async (req, res) => {
  try {
    const page  = parseInt(req.query.page  || '1',  10);
    const limit = parseInt(req.query.limit || '100', 10);
    const skip  = (page - 1) * limit;

    const [clicks, total] = await Promise.all([
      OrphanageClick.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      OrphanageClick.countDocuments()
    ]);

    return res.json({
      success: true,
      total,
      page,
      results: clicks.length,
      events:  clicks
    });

  } catch (error) {
    console.error('[FeatureClick] Admin fetch failed:', error.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
