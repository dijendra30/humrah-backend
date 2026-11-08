// routes/engagementNotificationsAdmin.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications: ONE read-only status route for operators.
//
//   GET /api/admin/engagement-notifications/status
//
// Mounted in server.js behind `authenticate` + `superAdminOnly`, and under /api/admin,
// so the Admin Dashboard session gate also applies. It cannot enable, send, retry or
// change anything; the worker is controlled only through environment variables.
// Aggregate counts only — no user ids, tokens or notification content.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const status = await require('../services/engagement/status').getStatus();
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...status });
  } catch (err) {
    console.error(`[ENGAGEMENT] status_failed ${(err && err.name) || 'Error'}`);
    return res.status(500).json({ success: false, message: 'Status is unavailable right now.' });
  }
});

module.exports = router;
