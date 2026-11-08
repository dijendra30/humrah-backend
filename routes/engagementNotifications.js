// routes/engagementNotifications.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications — the ONLY user-facing endpoints: the app reports
// that the signed-in user opened one of THEIR OWN engagement notifications.
//
//   POST /api/engagement-notifications/:id/opened          the notification was tapped
//   POST /api/engagement-notifications/:id/feature-opened  the screen it points to was opened from it
//
// Mounted behind `authenticate` + `enforceLegalAcceptance`. The user is always
// req.user._id (never a body/query value), so nobody can mark another user's
// notification. Idempotent: the first report sets the timestamp, repeats change nothing.
// Unknown, foreign and never-delivered ids all answer the same 404 (no enumeration).
// There is no endpoint that creates or sends a notification.
// -----------------------------------------------------------------------------
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const EngagementNotification = require('../models/EngagementNotification');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `uid:${req.user && req.user._id ? String(req.user._id) : 'anon'}`,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many requests. Try again shortly.' }),
});

const notFound = res => res.status(404).json({ success: false, message: 'Notification not found.' });

// Delivered (or possibly delivered) notifications only.
const deliveredFilter = { $or: [{ status: 'SENT' }, { status: 'DEAD_LETTER', possiblyDelivered: true }] };

async function report(req, res, kind) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id) || String(new mongoose.Types.ObjectId(id)) !== id) return notFound(res);
    const userId = req.user && req.user._id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required.' });

    const base = { _id: id, userId, ...deliveredFilter };
    const now = new Date();
    if (kind === 'opened') {
      await EngagementNotification.updateOne({ ...base, openedAt: null }, { $set: { openedAt: now } });
    } else {
      // Opening the feature from the notification implies the notification was opened.
      await EngagementNotification.updateOne({ ...base, openedAt: null }, { $set: { openedAt: now } });
      await EngagementNotification.updateOne({ ...base, featureOpenedAt: null }, { $set: { featureOpenedAt: now } });
    }
    const exists = await EngagementNotification.exists(base);
    if (!exists) return notFound(res);
    return res.status(204).end();
  } catch (err) {
    console.error(`[ENGAGEMENT] report_${kind}_failed ${(err && err.name) || 'Error'}`);
    return res.status(500).json({ success: false, message: 'Could not record that right now.' });
  }
}

router.post('/:id/opened', limiter, (req, res) => report(req, res, 'opened'));
router.post('/:id/feature-opened', limiter, (req, res) => report(req, res, 'feature-opened'));

module.exports = router;
