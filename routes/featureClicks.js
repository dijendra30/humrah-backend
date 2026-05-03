// routes/featureClicks.js
// Logs "coming soon" feature click events from the mobile app.
// Currently tracks: orphanage_click
// Designed to be extended for any future coming-soon feature.

const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');

// In-memory fallback store for when DB write is not critical.
// In production, write to MongoDB or forward to a dedicated analytics service.
const clickLog = [];

/**
 * POST /api/events/orphanage-click
 *
 * Body (all fields optional — designed to be resilient):
 *   {
 *     "userId"    : "string",       // logged-in user id
 *     "action"    : "orphanage_click",
 *     "timestamp" : "ISO_8601",     // client-side timestamp
 *     "source"    : "home_screen"
 *   }
 *
 * Response: always 200 (even on validation failure) so the app never crashes.
 *
 * Privacy: only minimal, non-sensitive data is stored.
 *          Do NOT add fields like location, device fingerprint, or contact info.
 */
router.post('/orphanage-click', auth, async (req, res) => {
  try {
    const {
      action    = 'orphanage_click',
      timestamp = new Date().toISOString(),
      source    = 'home_screen',
    } = req.body;

    // userId comes from the verified JWT via auth middleware — never trust body
    const userId = req.userId;

    const event = {
      userId,
      action,
      timestamp,
      source,
      receivedAt: new Date().toISOString(),
    };

    // ── Log for developer visibility ───────────────────────────────────────
    console.log('[FeatureClick] orphanage_click →', JSON.stringify(event));

    // ── In-memory store (replace with DB write when schema is ready) ───────
    clickLog.push(event);

    // ── 200 always — app must never receive a failure for a tracking call ──
    return res.status(200).json({ success: true, message: 'Event logged' });

  } catch (error) {
    // Swallow silently — tracking must never surface errors to the client
    console.error('[FeatureClick] Failed to log orphanage_click:', error.message);
    return res.status(200).json({ success: true, message: 'Event received' });
  }
});

/**
 * GET /api/events/orphanage-clicks
 * Admin-only endpoint to inspect logged clicks.
 * Replace with a proper admin auth guard before production use.
 */
router.get('/orphanage-clicks', auth, (req, res) => {
  // TODO: restrict to admin role
  return res.json({
    success: true,
    total: clickLog.length,
    events: clickLog.slice(-100), // last 100 events
  });
});

module.exports = router;
