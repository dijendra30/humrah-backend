// utils/sendWarningActivity.js
// Call this whenever a post violates community guidelines.
// Creates a WARNING activity entry AND sends a push notification.
//
// Usage (in any controller that issues a moderation warning):
//
//   const { sendWarningActivity } = require('../utils/sendWarningActivity');
//   await sendWarningActivity({ userId, entityId, entityType });

const mongoose                  = require('mongoose');
const { createOrAggregateActivity } = require('../controllers/activityController');
const { sendGamingPush }            = require('./gamingPush');

// A fixed sentinel ObjectId used as actorId for all system-issued activities.
// Different from any real userId → the self-skip guard in createOrAggregateActivity
// will never block WARNING even though it is issued on behalf of the target user.
const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000001');

/**
 * @param {Object} params
 * @param {string|ObjectId} params.userId       — the user who receives the warning
 * @param {string|ObjectId} [params.entityId]   — the post/session that was flagged (optional)
 * @param {string}          [params.entityType] — 'post' | 'food_post' | 'gaming_session'
 */
async function sendWarningActivity({ userId, entityId = null, entityType = 'post' }) {
  const warningMsg =
    '⚠ Your post violates community guidelines. Please edit or remove it.';

  // 1. Activity feed entry — always
  //    actorId = SYSTEM_ACTOR_ID so self-skip guard is never triggered
  await createOrAggregateActivity({
    userId,
    actorId:    SYSTEM_ACTOR_ID,
    type:       'WARNING',
    entityType,
    entityId,
    message:    warningMsg,
  });

  // 2. Push notification — always (spec §6)
  //    Note: createOrAggregateActivity also fires the push internally for WARNING,
  //    but we keep it here too as a safety net in case the caller path differs.
  await sendGamingPush({
    recipientId: userId,
    title:       '⚠ Community Guidelines',
    body:        warningMsg,
    data: {
      type:       'WARNING',
      entityType,
      entityId:   entityId ? entityId.toString() : '',
    },
  });
}

module.exports = { sendWarningActivity, SYSTEM_ACTOR_ID };
