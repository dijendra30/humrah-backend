// routes/adminDashboardAuth.js — RETIRED Admin Dashboard sign-in (Phase 3, Admin OTP security).
//
// The old flow had no admin identity, logged the code to the server console, used Math.random,
// raced its attempt counter and issued a 24 h full-account JWT. It is replaced by
// routes/adminAuth.js (/api/admin/auth/*). These paths stay mounted only so an old dashboard
// build shows a clear message instead of a generic 404.
const express = require('express');
const router = express.Router();

const moved = (req, res) => res.status(410).json({
  success: false,
  code: 'ADMIN_LOGIN_MOVED',
  message: 'Admin sign-in has been upgraded. Reload the admin dashboard and sign in with your admin email.',
});

router.post('/otp/send', moved);
router.post('/otp/verify', moved);

module.exports = router;
