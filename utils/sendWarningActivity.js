// utils/sendWarningActivity.js
// Call this whenever a post violates community guidelines.
// Creates a WARNING activity entry AND sends a push notification.
//
// Usage (in any controller that issues a moderation warning):
//
//   const { sendWarningActivity } = require('../utils/sendWarningActivity');
//   await sendWarningActivity({ userId, entityId, entityType });

const { createOrAggregateActivity } = require('../controllers/activityController');
const { sendGamingPush }            = require('./gamingPush');

/**
 * @param {Object} params
 * @param {string|ObjectId} params.userId      — the user who receives the warning
 * @param {string|ObjectId} [params.entityId]  — the post/session that was flagged
 * @param {string}          [params.entityType] — 'post' | 'food_post' | 'gaming_session'
 */
async function sendWarningActivity({ userId, entityId = null, entityType = 'post' }) {
  const warningMsg =
    '⚠ Your post violates community guidelines. Please edit or remove it.';

  // 1. Activity feed entry — always
  await createOrAggregateActivity({
    userId,
    actorId:    userId,      // system action — actor = receiver is fine here
    type:       'WARNING',
    entityType,
    entityId,
    message:    warningMsg,
  });

  // 2. Push notification — always (spec §6)
  await sendGamingPush({
    recipientId: userId,
    title:       '⚠ Community Guidelines',
    body:        'Your post violates our community guidelines. Please edit or remove it.',
    data: {
      type:       'WARNING',
      entityType,
      entityId:   entityId ? entityId.toString() : '',
    },
  });
}

module.exports = { sendWarningActivity };
