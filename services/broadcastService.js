// services/broadcastService.js — Core broadcast business logic (Phase 1)
// Handles audience filtering, send orchestration, notification history, and delivery stats.

'use strict';

const User         = require('../models/User');
const Broadcast    = require('../models/Broadcast');
const Notification = require('../models/Notification');
const broadcastFcm = require('./broadcastFcmService');

// Configurable batch size for user fetching (default 100 for MVP)
const BATCH_SIZE = parseInt(process.env.BROADCAST_BATCH_SIZE, 10) || 100;

// =============================================
// AUDIENCE QUERY BUILDER
// =============================================

/**
 * Build a MongoDB query to find eligible broadcast recipients.
 * Automatically excludes suspended, banned, and deleted users.
 *
 * @param {object} filters - Audience targeting filters
 * @param {string} filters.audienceType
 * @param {string} [filters.targetState]
 * @param {string} [filters.targetCity]
 * @param {string} [filters.targetArea]
 * @param {boolean} [filters.onlyVerifiedUsers]
 * @param {boolean} [filters.onlyPremiumUsers]
 * @returns {object} MongoDB query object
 */
function buildAudienceQuery(filters) {
  const query = {
    // Exclude suspended, banned users
    status: 'ACTIVE',
    // Exclude users who requested account deletion
    deletionRequestedAt: null,
    // Must have at least one FCM token to receive push notifications
    fcmTokens: { $exists: true, $ne: [] },
    // Only regular users, not admins
    role: 'USER',
  };

  switch (filters.audienceType) {
    case 'VERIFIED_USERS':
      query.verified = true;
      break;

    case 'PREMIUM_USERS':
      query.isPremium = true;
      break;

    case 'STATE':
      if (filters.targetState) {
        query['questionnaire.state'] = new RegExp(`^${escapeRegex(filters.targetState)}$`, 'i');
      }
      break;

    case 'CITY':
      if (filters.targetCity) {
        query['questionnaire.city'] = new RegExp(`^${escapeRegex(filters.targetCity)}$`, 'i');
      }
      break;

    case 'AREA':
      if (filters.targetArea) {
        query['questionnaire.area'] = new RegExp(`^${escapeRegex(filters.targetArea)}$`, 'i');
      }
      break;

    case 'CUSTOM':
      // Combination filters
      if (filters.onlyVerifiedUsers) query.verified = true;
      if (filters.onlyPremiumUsers)  query.isPremium = true;
      if (filters.targetState)       query['questionnaire.state'] = new RegExp(`^${escapeRegex(filters.targetState)}$`, 'i');
      if (filters.targetCity)        query['questionnaire.city']  = new RegExp(`^${escapeRegex(filters.targetCity)}$`, 'i');
      if (filters.targetArea)        query['questionnaire.area']  = new RegExp(`^${escapeRegex(filters.targetArea)}$`, 'i');
      break;

    case 'EVERYONE':
    default:
      // No additional filters — all active users with FCM tokens
      break;
  }

  return query;
}

/**
 * Get estimated audience count without fetching all users.
 *
 * @param {object} filters - Same shape as buildAudienceQuery input
 * @returns {Promise<{ count: number, query: object, summary: string }>}
 */
async function getAudienceCount(filters) {
  const query = buildAudienceQuery(filters);
  const count = await User.countDocuments(query);

  const summary = buildAudienceSummary(filters, count);

  return { count, query, summary };
}

/**
 * Build a human-readable audience summary.
 */
function buildAudienceSummary(filters, count) {
  const parts = [];

  switch (filters.audienceType) {
    case 'EVERYONE':
      parts.push('All active users');
      break;
    case 'VERIFIED_USERS':
      parts.push('Verified users');
      break;
    case 'PREMIUM_USERS':
      parts.push('Premium users');
      break;
    case 'STATE':
      parts.push(`Users in state: ${filters.targetState}`);
      break;
    case 'CITY':
      parts.push(`Users in city: ${filters.targetCity}`);
      break;
    case 'AREA':
      parts.push(`Users in area: ${filters.targetArea}`);
      break;
    case 'CUSTOM':
      if (filters.onlyVerifiedUsers) parts.push('Verified');
      if (filters.onlyPremiumUsers)  parts.push('Premium');
      if (filters.targetState)       parts.push(`State: ${filters.targetState}`);
      if (filters.targetCity)        parts.push(`City: ${filters.targetCity}`);
      if (filters.targetArea)        parts.push(`Area: ${filters.targetArea}`);
      if (parts.length === 0)        parts.push('Custom filter');
      break;
  }

  return `${parts.join(' + ')} — ${count} recipient(s) with push enabled`;
}

// =============================================
// SEND ORCHESTRATION
// =============================================

/**
 * Send a broadcast to its audience.
 * Fetches users in configurable batches, sends FCM notifications,
 * creates notification history records, and updates delivery counts.
 *
 * @param {string} broadcastId - MongoDB ObjectId of the broadcast
 * @returns {Promise<{ success: boolean, totalRecipients: number, deliveredCount: number, failedCount: number }>}
 */
async function sendToAudience(broadcastId) {
  const broadcast = await Broadcast.findById(broadcastId);
  if (!broadcast) throw new Error('Broadcast not found');
  if (broadcast.status !== 'DRAFT') {
    throw new Error(`Cannot send broadcast with status "${broadcast.status}". Only DRAFT broadcasts can be sent.`);
  }

  // Mark as SENDING
  broadcast.status = 'SENDING';
  broadcast.sentAt = new Date();
  await broadcast.save();

  console.log(`[BroadcastService] Starting send for broadcast ${broadcastId}`);

  const query = buildAudienceQuery({
    audienceType:      broadcast.audienceType,
    targetState:       broadcast.targetState,
    targetCity:        broadcast.targetCity,
    targetArea:        broadcast.targetArea,
    onlyVerifiedUsers: broadcast.onlyVerifiedUsers,
    onlyPremiumUsers:  broadcast.onlyPremiumUsers,
  });

  let totalRecipients = 0;
  let deliveredCount  = 0;
  let failedCount     = 0;
  let skip = 0;
  let hasMore = true;

  try {
    while (hasMore) {
      // Fetch users in batches
      const users = await User.find(query)
        .select('_id fcmTokens')
        .skip(skip)
        .limit(BATCH_SIZE)
        .lean();

      if (users.length === 0) {
        hasMore = false;
        break;
      }

      totalRecipients += users.length;
      skip += BATCH_SIZE;
      if (users.length < BATCH_SIZE) hasMore = false;

      // Build FCM payload
      const payload = {
        title: broadcast.title,
        body:  broadcast.message,
        data: {
          type:        'ADMIN_BROADCAST',
          broadcastId: broadcast._id.toString(),
        },
      };

      // Send to this batch
      const batchResult = await broadcastFcm.sendToMultipleUsers(users, payload);
      deliveredCount += batchResult.successCount;
      failedCount    += batchResult.failureCount;

      // Create notification history records for this batch
      const notificationDocs = batchResult.results.map(result => ({
        userId:       result.userId,
        title:        broadcast.title,
        message:      broadcast.message,
        type:         'ADMIN_BROADCAST',
        broadcastId:  broadcast._id,
        createdBy:    'admin',
        deliveredAt:  result.success ? new Date() : null,
        fcmMessageId: result.fcmMessageId || null,
      }));

      // Bulk insert notification records (efficient)
      if (notificationDocs.length > 0) {
        await Notification.insertMany(notificationDocs, { ordered: false }).catch(insertErr => {
          console.error('[BroadcastService] Error inserting notification history:', insertErr.message);
        });
      }

      console.log(`[BroadcastService] Batch processed: ${users.length} users (delivered=${batchResult.successCount}, failed=${batchResult.failureCount})`);
    }

    // Update broadcast with final counts
    const finalStatus = failedCount > 0 && deliveredCount === 0 ? 'FAILED' : 'SENT';
    await Broadcast.findByIdAndUpdate(broadcastId, {
      status:          finalStatus,
      totalRecipients,
      deliveredCount,
      failedCount,
    });

    console.log(`[BroadcastService] Broadcast ${broadcastId} completed: status=${finalStatus} total=${totalRecipients} delivered=${deliveredCount} failed=${failedCount}`);

    return { success: true, totalRecipients, deliveredCount, failedCount };
  } catch (err) {
    console.error(`[BroadcastService] Send failed for broadcast ${broadcastId}:`, err.message);

    // Mark as FAILED and save partial progress
    await Broadcast.findByIdAndUpdate(broadcastId, {
      status: 'FAILED',
      totalRecipients,
      deliveredCount,
      failedCount,
    });

    throw err;
  }
}

/**
 * Retry failed notification sends for a broadcast.
 *
 * @param {string} broadcastId
 * @returns {Promise<{ retriedCount: number, newDeliveredCount: number }>}
 */
async function retryFailedSends(broadcastId) {
  const broadcast = await Broadcast.findById(broadcastId);
  if (!broadcast) throw new Error('Broadcast not found');

  // Find notifications that were not delivered
  const failedNotifications = await Notification.find({
    broadcastId,
    deliveredAt: null,
  }).select('userId').lean();

  if (failedNotifications.length === 0) {
    return { retriedCount: 0, newDeliveredCount: 0 };
  }

  console.log(`[BroadcastService] Retrying ${failedNotifications.length} failed sends for broadcast ${broadcastId}`);

  const payload = {
    title: broadcast.title,
    body:  broadcast.message,
    data: {
      type:        'ADMIN_BROADCAST',
      broadcastId: broadcast._id.toString(),
    },
  };

  let newDeliveredCount = 0;

  for (const notif of failedNotifications) {
    const result = await broadcastFcm.sendToSingleUser(notif.userId, payload);
    if (result.success) {
      newDeliveredCount++;
      await Notification.findOneAndUpdate(
        { broadcastId, userId: notif.userId, deliveredAt: null },
        { deliveredAt: new Date(), fcmMessageId: result.fcmMessageId },
      );
    }
  }

  // Update broadcast counts
  if (newDeliveredCount > 0) {
    await Broadcast.findByIdAndUpdate(broadcastId, {
      $inc: {
        deliveredCount: newDeliveredCount,
        failedCount:   -newDeliveredCount,
      },
    });
  }

  console.log(`[BroadcastService] Retry complete: ${newDeliveredCount}/${failedNotifications.length} now delivered`);

  return { retriedCount: failedNotifications.length, newDeliveredCount };
}

// =============================================
// HELPERS
// =============================================

/**
 * Escape special regex characters in user input.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  buildAudienceQuery,
  getAudienceCount,
  sendToAudience,
  retryFailedSends,
};
