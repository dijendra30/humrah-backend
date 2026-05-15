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
      return res.status(400).json({ error: "fcmToken is required" });
    }

    // $addToSet prevents duplicates — safe to call on every app launch
    await User.findByIdAndUpdate(
      req.user._id,
      { $addToSet: { fcmTokens: fcmToken.trim() } },
      { new: false }
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("[fcmToken] Error saving FCM token:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
