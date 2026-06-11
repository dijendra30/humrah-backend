/**
 * routes/fcmToken.js
 *
 * Registers/updates the user's FCM device token.
 * Mounted in server.js:
 *
 *   const fcmTokenRoutes = require('./routes/fcmToken');
 *   app.use('/api/auth', authenticate, fcmTokenRoutes);
 *
 * Or add the route directly to your existing auth.js router.
 */

const express = require("express");
const router  = express.Router();
const User    = require("../models/User");

// POST /api/auth/fcm-token
// Body: { fcmToken: string }
// Saves (or deduplicates) the FCM token for the authenticated user.
router.post("/fcm-token", async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken || typeof fcmToken !== "string" || fcmToken.trim() === "") {
      return res.status(400).json({ success: false, message: "fcmToken is required" });
    }

    // $addToSet prevents duplicates — safe to call on every app launch
    await User.findByIdAndUpdate(
      req.user._id,
      { $addToSet: { fcmTokens: fcmToken.trim() } },
      { new: false }
    );

    console.log(`[FCM] token registered for user ${req.user._id}`);
    res.json({ success: true, message: "FCM token registered" });
  } catch (e) {
    console.error("[fcmToken] Error saving FCM token:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// DELETE /api/auth/fcm-token
// Body: { fcmToken: string }
// Removes a specific FCM token on logout so stale tokens don't pile up.
router.delete("/fcm-token", async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken || typeof fcmToken !== "string") {
      return res.status(400).json({ success: false, message: "fcmToken is required" });
    }
    await User.findByIdAndUpdate(
      req.user._id,
      { $pull: { fcmTokens: fcmToken.trim() } }
    );
    res.json({ success: true, message: "FCM token removed" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/auth/fcm-debug   ← DEVELOPMENT ONLY — remove before public release
// Returns the number of tokens saved for the current user (no token values).
router.get("/fcm-debug", async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("fcmTokens");
    res.json({
      success:    true,
      userId:     req.user._id,
      tokenCount: user?.fcmTokens?.length ?? 0,
      // Show only first 8 chars of each token for privacy
      tokens:     (user?.fcmTokens ?? []).map(t => t.substring(0, 8) + "..."),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
