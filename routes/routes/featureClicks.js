// routes/featureClicks.js
// Logs "coming soon" feature click events from the Android app.
// Currently tracks: orphanage_click  (Visit Orphanage card on Home screen)
//
// Anti-spam logic:
//   - ONE document per user (unique index on userId in OrphanageClick model)
//   - findOneAndUpdate + upsert: first tap creates the record,
//     every subsequent tap only increments tapCount + updates lastTapAt
//   - No duplicate documents can be created regardless of how many times
//     the user taps — MongoDB enforces this at the index level
//
// Other design goals:
//   - Always return HTTP 200 — tracking must NEVER crash or block the app
//   - userId comes from JWT (auth middleware) — never trusted from request body
//   - name + email fetched server-side on first tap only (setOnInsert)

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
//     "action"    : "orphanage_click",
//     "timestamp" : "2025-05-03T...",   // client-side ISO timestamp
//     "source"    : "home_screen"
//   }
//
// Behaviour:
//   First tap  → creates a new document (tapCount = 1, firstTapAt = now)
//   2nd+ taps  → increments tapCount, updates lastTapAt — no new document
// ─────────────────────────────────────────────────────────────────────────────

router.post('/orphanage-click', auth, async (req, res) => {
  try {
    const userId   = req.userId;
    const source   = req.body.source    || 'home_screen';
    const now      = new Date();

    // Fetch user info — only used on first insert (setOnInsert), ignored on updates
    const user  = await User.findById(userId).select('firstName lastName email').lean();
    const name  = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '';
    const email = user?.email || '';

    // findOneAndUpdate with upsert:
    //   $setOnInsert → only applied when creating the doc for the first time
    //   $inc         → always increments tapCount
    //   $set         → always updates lastTapAt
    const result = await OrphanageClick.findOneAndUpdate(
      { userId },                          // filter — match by user
      {
        $setOnInsert: {                    // written ONLY on first insert
          name,
          email,
          source,
          action:     'orphanage_click',
          firstTapAt: now
        },
        $inc: { tapCount: 1 },            // always: increment tap count
        $set: { lastTapAt: now }          // always: update last tap time
      },
      {
        upsert:    true,                  // create if not found
        new:       true,                  // return the updated/created doc
        setDefaultsOnInsert: true
      }
    );

    const isFirstTap = result.tapCount === 1;
    console.log(
      `[FeatureClick] orphanage_click → userId=${userId} name="${name}" ` +
      `tapCount=${result.tapCount} ${isFirstTap ? '(new record)' : '(incremented)'}`
    );

    return res.status(200).json({ success: true, message: 'Event logged' });

  } catch (error) {
    // Swallow silently — tracking must never surface errors to the client
    console.error('[FeatureClick] Failed to log orphanage_click:', error.message);
    return res.status(200).json({ success: true, message: 'Event received' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/events/orphanage-clicks
//
// Admin inspection — one row per unique user, showing tapCount.
// Sorted by tapCount descending so highest-interest users appear first.
// TODO: swap `auth` for `adminOnly` middleware before going to production.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/orphanage-clicks', auth, async (req, res) => {
  try {
    const page  = parseInt(req.query.page  || '1',   10);
    const limit = parseInt(req.query.limit || '100',  10);
    const skip  = (page - 1) * limit;

    const [records, totalUsers, totalTaps] = await Promise.all([
      OrphanageClick.find()
        .sort({ tapCount: -1, lastTapAt: -1 })  // most engaged users first
        .skip(skip)
        .limit(limit)
        .lean(),
      OrphanageClick.countDocuments(),
      OrphanageClick.aggregate([
        { $group: { _id: null, total: { $sum: '$tapCount' } } }
      ])
    ]);

    return res.json({
      success:    true,
      totalUsers,                                       // unique users who tapped
      totalTaps:  totalTaps[0]?.total || 0,            // all taps combined
      page,
      results:    records.length,
      records                                           // one entry per user
    });

  } catch (error) {
    console.error('[FeatureClick] Admin fetch failed:', error.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
