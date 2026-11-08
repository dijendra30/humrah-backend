// models/EngagementNotification.js
// -----------------------------------------------------------------------------
// Personal Engagement Notifications (Phase 1): the persistent queue, the per-user
// history and the analytics timestamps — one document per notification.
//
// Completely separate from the Broadcast system (models/Broadcast.js and
// models/Notification.js): nothing here is read by, written by, or counted against
// broadcasts, and broadcasts never touch this collection.
//
// Status machine (services/engagement/queueStates.js enforces it with conditional
// updates; nothing else may change `status`):
//
//   PENDING ──claim──▶ PROCESSING ──▶ SENT          (FCM accepted it for ≥1 device)
//      │                  │  ├──▶ PENDING         (retry / quiet-hours defer / lease recovered before send)
//      │                  │  ├──▶ FAILED          (permanent: no valid device)
//      │                  │  ├──▶ DEAD_LETTER     (retries exhausted, or outcome unknown after a crash)
//      └──▶ CANCELLED ◀───┘                       (user no longer eligible / event gone / preference off)
//
// SENT, FAILED, CANCELLED and DEAD_LETTER are terminal for the worker. Phase 3: an admin
// may requeue FAILED / DEAD_LETTER → PENDING only if it never reached FCM (see
// services/engagement/adminQueries.requeue).
//
// Privacy: no coordinates, distances, other users' ids or names are stored here.
// `eventRef.id` is the id of a PUBLIC object (a sports plan, a Room, a question) or a
// catalog key — never a person.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const { CATEGORIES } = require('../config/engagementNotificationConfig');

const STATUSES = Object.freeze(['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'DEAD_LETTER']);
const EVENT_TYPES = Object.freeze([
  'NEARBY_NEW_MEMBERS', 'SPORTS_PLAN', 'HUMRAH_ROOM', 'COMMUNITY_QUESTIONS', 'CATALOG',
]);

const attemptSchema = new mongoose.Schema({
  at:           { type: Date, required: true },
  outcome:      { type: String, enum: ['ACCEPTED', 'TRANSIENT', 'PERMANENT', 'UNKNOWN'], required: true },
  code:         { type: String, default: null, maxlength: 80 },
  successCount: { type: Number, default: 0 },
  failureCount: { type: Number, default: 0 },
}, { _id: false });

const engagementNotificationSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  category: { type: String, enum: CATEGORIES, required: true },

  // Content (rendered from a template; Phase 2 may supply other templates).
  templateKey:     { type: String, required: true, maxlength: 80 },
  templateVersion: { type: Number, default: 1 },
  // Phase 2: language of the template used ('en' | 'hi' | 'hinglish'); null on Phase 1 rows.
  language:        { type: String, default: null, maxlength: 10 },
  title:           { type: String, required: true, maxlength: 80 },
  body:            { type: String, required: true, maxlength: 200 },

  // The verified Humrah event behind this notification.
  eventType: { type: String, enum: EVENT_TYPES, required: true },
  eventRef: {
    kind: { type: String, required: true, maxlength: 40 },
    id:   { type: String, required: true, maxlength: 120 },
  },
  eventKey:       { type: String, required: true, maxlength: 160 },  // stable dedupe key, e.g. SPORTS_PLAN:<id>
  idempotencyKey: { type: String, required: true, maxlength: 200 },  // `${userId}:${eventKey}`
  relevantUntil:  { type: Date, default: null },

  status:   { type: String, enum: STATUSES, default: 'PENDING', required: true },
  priority: { type: Number, default: 0 },
  score:    { type: Number, default: 0 },

  // Scheduling. nextAttemptAt is the single "due" field the claim query uses.
  scheduledAt:   { type: Date, required: true },
  nextAttemptAt: { type: Date, required: true },
  attemptCount:  { type: Number, default: 0, min: 0 },
  lastAttemptAt: { type: Date, default: null },

  // Claim lease (multi-worker). inFlight=true from just before the FCM call until its
  // outcome is written; a lease that expires while inFlight means "possibly sent".
  lockedBy:    { type: String, default: null, maxlength: 120 },
  lockedUntil: { type: Date, default: null },
  inFlight:    { type: Boolean, default: false },

  // Delivery results. Counts and error codes only — never tokens.
  fcm: {
    successCount:         { type: Number, default: 0 },
    failureCount:         { type: Number, default: 0 },
    invalidTokensRemoved: { type: Number, default: 0 },
    deviceCount:          { type: Number, default: 0 },
  },
  attemptLog:        { type: [attemptSchema], default: [] },
  errorCode:         { type: String, default: null, maxlength: 80 },
  errorDetail:       { type: String, default: null, maxlength: 200 },
  possiblyDelivered: { type: Boolean, default: false },
  slotOutcome:       { type: String, enum: ['HELD', 'CONSUMED', 'RELEASED'], default: 'HELD' },
  // Phase 3: admin requeue of a FAILED / DEAD_LETTER notification that never reached FCM.
  requeueCount: { type: Number, default: 0, min: 0 },
  requeuedAt:   { type: Date, default: null },
  requeuedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Analytics — each a separate fact; none implies another.
  queuedAt:        { type: Date, default: null },
  firstAttemptAt:  { type: Date, default: null },
  fcmAcceptedAt:   { type: Date, default: null },  // FCM accepted it. NOT proof it was displayed.
  failedAt:        { type: Date, default: null },
  cancelledAt:     { type: Date, default: null },
  cancelReason:    { type: String, default: null, maxlength: 60 },
  openedAt:        { type: Date, default: null },  // reported by the app (authenticated)
  featureOpenedAt: { type: Date, default: null },  // reported by the app (authenticated)
}, { timestamps: true });

// Claim query: { status: 'PENDING', nextAttemptAt: { $lte: now } } sorted by nextAttemptAt.
// The stale-lease sweep ({ status: 'PROCESSING', lockedUntil < now }) also uses its prefix.
engagementNotificationSchema.index({ status: 1, nextAttemptAt: 1 });
// Per-user history: frequency diagnostics, "last category", opened-category boost.
engagementNotificationSchema.index({ userId: 1, createdAt: -1 });
// Never two notifications to one user about one event — enforced by the database.
engagementNotificationSchema.index({ idempotencyKey: 1 }, { unique: true });
// Data minimisation: history is kept for 180 days, then removed by Mongo.
engagementNotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

const EngagementNotification = mongoose.model('EngagementNotification', engagementNotificationSchema);
module.exports = EngagementNotification;
module.exports.STATUSES = STATUSES;
module.exports.EVENT_TYPES = EVENT_TYPES;
