// routes/settings.js
// All Account Settings endpoints — all require authentication

const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');
const ctrl    = require('../controllers/settingsController');

// ── Email change (2-step OTP flow) ────────────────────────────────────────────
// Step 1: Send OTP to new email
router.post('/email/send-otp', auth, ctrl.sendEmailChangeOTP);

// Step 2: Verify OTP and apply new email
router.put('/email', auth, ctrl.updateEmail);

// ── Password ──────────────────────────────────────────────────────────────────
router.put('/password', auth, ctrl.updatePassword);

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications', auth, ctrl.getNotifications);
router.put('/notifications', auth, ctrl.updateNotifications);

// ── Blocked users ─────────────────────────────────────────────────────────────
router.get('/blocked-users',      auth, ctrl.getBlockedUsers);
router.post('/block',             auth, ctrl.blockUser);
router.delete('/unblock/:userId', auth, ctrl.unblockUser);

// ── Bug report ────────────────────────────────────────────────────────────────
router.post('/report-bug', auth, ctrl.reportBug);

module.exports = router;
