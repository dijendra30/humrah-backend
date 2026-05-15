// routes/settings.js
// All Account Settings endpoints — all require authentication

const express  = require('express');
const router   = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl     = require('../controllers/settingsController');

// ── Email change (2-step OTP flow) ────────────────────────────────────────────
router.post('/email/send-otp', authenticate, ctrl.sendEmailChangeOTP);
router.put('/email',           authenticate, ctrl.updateEmail);

// ── Password ──────────────────────────────────────────────────────────────────
router.put('/password', authenticate, ctrl.updatePassword);

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications', authenticate, ctrl.getNotifications);
router.put('/notifications', authenticate, ctrl.updateNotifications);

// ── Blocked users ─────────────────────────────────────────────────────────────
router.get('/blocked-users',       authenticate, ctrl.getBlockedUsers);
router.post('/block',              authenticate, ctrl.blockUser);
router.delete('/unblock/:userId',  authenticate, ctrl.unblockUser);

// ── Bug report ────────────────────────────────────────────────────────────────
router.post('/report-bug', authenticate, ctrl.reportBug);

module.exports = router;
