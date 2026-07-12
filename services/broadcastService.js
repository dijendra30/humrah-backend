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

async function sendToAudience(broadcastId) {
  const broadcast = await Broadcast.findById(broadcastId);
  if (!broadcast) throw new Error('Broadcast not found');
  
  if (broadcast.status === 'DRAFT') {
    broadcast.status = 'SENDING';
    broadcast.sentAt = new Date();
    await broadcast.save();
  } else if (broadcast.status !== 'SENDING') {
    throw new Error(`Cannot send broadcast with status "${broadcast.status}". Only DRAFT or SENDING broadcasts can be sent.`);
  }

  console.log(`[BroadcastService] Starting/Resuming send for broadcast ${broadcastId}`);

  const query = buildAudienceQuery({
    audienceType:      broadcast.audienceType,
    targetState:       broadcast.targetState,
    targetCity:        broadcast.targetCity,
    targetArea:        broadcast.targetArea,
    onlyVerifiedUsers: broadcast.onlyVerifiedUsers,
    onlyPremiumUsers:  broadcast.onlyPremiumUsers,
  });

  let hasMore = true;

  try {
    while (hasMore) {
      const currentBroadcast = await Broadcast.findById(broadcastId);
      const cursorQuery = { ...query };
      
      if (currentBroadcast.lastProcessedUserId) {
        cursorQuery._id = { $gt: currentBroadcast.lastProcessedUserId };
      }

      // Fetch users using cursor
      const users = await User.find(cursorQuery)
        .sort({ _id: 1 })
        .select('_id fcmTokens fcmDevices')
        .limit(BATCH_SIZE)
        .lean();

      if (users.length === 0) {
        hasMore = false;
        break;
      }

      const lastUserInBatch = users[users.length - 1];

      // Build FCM payload
      const payload = {
        title: broadcast.title,
        body:  broadcast.message,
        data: {
          type:          'ADMIN_BROADCAST',
          broadcastId:   broadcast._id.toString(),
          broadcastType: broadcast.type || 'ANNOUNCEMENT',
          title:         broadcast.title,
          message:       broadcast.message,
          language:      broadcast.language || 'en',
          category:      broadcast.audienceType || 'EVERYONE',
          sentAt:        new Date().toISOString(),
          deepLink:      `humrah://broadcast/${broadcast._id.toString()}`,
          priority:      'high',
          expiresAt:     broadcast.expiresAt ? broadcast.expiresAt.toISOString() : ''
        },
      };

      // Send to this batch via refactored FCM service
      const batchResult = await broadcastFcm.sendToMultipleUsers(users, payload);

      // Create notification history records
      const notificationDocs = batchResult.results.map(result => {
        const user = users.find(u => u._id.toString() === result.userId.toString());
        let appVersion = null, androidVersion = null, reason = result.reason || null;
        if (user && user.fcmDevices && user.fcmDevices.length > 0) {
          const latestDevice = user.fcmDevices.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
          appVersion = latestDevice.appVersion;
          androidVersion = latestDevice.androidVersion;
        }
        return {
          userId:       result.userId,
          title:        broadcast.title,
          message:      broadcast.message,
          type:         'ADMIN_BROADCAST',
          broadcastId:  broadcast._id,
          createdBy:    'admin',
          deliveredAt:  result.success ? new Date() : null,
          fcmMessageId: result.fcmMessageId || null,
          androidVersion: androidVersion,
          appVersion: appVersion,
          failureReason: reason
        };
      });

      if (notificationDocs.length > 0) {
        await Notification.insertMany(notificationDocs, { ordered: false }).catch(insertErr => {
          console.error('[BroadcastService] Error inserting notification history:', insertErr.message);
        });
      }

      // Atomically persist progress so it can be resumed
      await Broadcast.findByIdAndUpdate(broadcastId, {
        $inc: { 
          totalRecipients: users.length,
          deliveredCount: batchResult.successCount,
          failedCount: batchResult.failureCount,
          currentBatch: 1
        },
        $set: { lastProcessedUserId: lastUserInBatch._id }
      });

      console.log(`[BroadcastService] Batch processed: ${users.length} users. Last ID: ${lastUserInBatch._id}`);
    }

    // Finalize
    const finalBroadcast = await Broadcast.findById(broadcastId);
    const finalStatus = finalBroadcast.failedCount > 0 && finalBroadcast.deliveredCount === 0 ? 'FAILED' : 'SENT';
    
    await Broadcast.findByIdAndUpdate(broadcastId, { status: finalStatus });

    console.log(`[BroadcastService] Broadcast ${broadcastId} completed. Status: ${finalStatus}`);
    return { success: true };
  } catch (err) {
    console.error(`[BroadcastService] Send loop interrupted for broadcast ${broadcastId}:`, err.message);
    // Let it stay in SENDING status so it can be resumed later
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
      type:          'ADMIN_BROADCAST',
      broadcastId:   broadcast._id.toString(),
      broadcastType: broadcast.type || 'ANNOUNCEMENT',
      title:         broadcast.title,
      message:       broadcast.message,
      language:      broadcast.language || 'en',
      category:      broadcast.audienceType || 'EVERYONE',
      sentAt:        new Date().toISOString(),
      deepLink:      `humrah://broadcast/${broadcast._id.toString()}`,
      priority:      'high',
      expiresAt:     broadcast.expiresAt ? broadcast.expiresAt.toISOString() : ''
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
