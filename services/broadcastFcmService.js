// services/broadcastFcmService.js — FCM sender for broadcast notifications
// Handles single-user, multi-user, and batch FCM delivery with retry logic.

'use strict';

const admin = require('../config/firebase');
const User  = require('../models/User');

const FCM_BATCH_SIZE = 500;
const MAX_RETRIES    = 3;

/**
 * Send a broadcast push notification to a single user.
 */
async function sendToSingleUser(userId, payload) {
  try {
    const user = await User.findById(userId).select('fcmTokens').lean();
    if (!user?.fcmTokens?.length) {
      return { success: false, fcmMessageId: null, reason: 'no_tokens' };
    }

    const { results } = await sendToMultipleUsers([{ _id: userId, fcmTokens: user.fcmTokens }], payload);
    const result = results.find(r => r.userId.toString() === userId.toString());
    
    return { 
      success: result?.success || false, 
      fcmMessageId: result?.fcmMessageId || null, 
      reason: result?.reason 
    };
  } catch (err) {
    console.error('[BroadcastFCM] sendToSingleUser error:', err.message);
    return { success: false, fcmMessageId: null, reason: err.message };
  }
}

/**
 * Send a broadcast push notification to multiple users.
 * Batches tokens securely and efficiently using Firebase Admin SDK.
 *
 * @param {Array<{ _id: string, fcmTokens: string[] }>} users - User objects with tokens
 * @param {object} payload - { title, body, data }
 * @returns {Promise<{ successCount: number, failureCount: number, results: Array }>}
 */
async function sendToMultipleUsers(users, payload) {
  if (!admin.apps.length) {
    console.warn('[BroadcastFCM] Firebase Admin not initialized. Skipping push.');
    return { 
      successCount: 0, 
      failureCount: users.length, 
      results: users.map(u => ({ userId: u._id, success: false, reason: 'firebase_not_initialized' })) 
    };
  }

  const results = [];
  
  // Flatten tokens: [{ token, userId }]
  const tokenMap = new Map(); // token -> userId
  const validTokens = [];
  
  for (const user of users) {
    if (!user.fcmTokens || user.fcmTokens.length === 0) {
      results.push({ userId: user._id, success: false, reason: 'no_tokens' });
      continue;
    }
    for (const token of user.fcmTokens) {
      if (!tokenMap.has(token)) {
        tokenMap.set(token, user._id.toString());
        validTokens.push(token);
      }
    }
  }

  // Stringify payload
  const stringData = {};
  if (payload.data) {
    for (const [k, v] of Object.entries(payload.data)) {
      stringData[k] = v == null ? '' : String(v);
    }
  }

  // Chunk valid tokens into max Firebase limits
  for (let i = 0; i < validTokens.length; i += FCM_BATCH_SIZE) {
    const chunk = validTokens.slice(i, i + FCM_BATCH_SIZE);
    const chunkResult = await sendChunkWithRetry(chunk, payload.title, payload.body, stringData, tokenMap, 1);
    results.push(...chunkResult.results);
  }
  
  // Aggregate results per user (a user might have multiple tokens)
  const userResultsMap = new Map();
  for (const res of results) {
    if (!userResultsMap.has(res.userId) || (!userResultsMap.get(res.userId).success && res.success)) {
      userResultsMap.set(res.userId, res);
    }
  }
  
  const finalResults = Array.from(userResultsMap.values());
  const finalSuccess = finalResults.filter(r => r.success).length;
  const finalFailure = finalResults.filter(r => !r.success).length;

  return { successCount: finalSuccess, failureCount: finalFailure, results: finalResults };
}

/**
 * Sends a single chunk of up to 500 tokens, handling dead token removal and transient retries.
 */
async function sendChunkWithRetry(tokens, title, body, data, tokenMap, attempt = 1) {
  const fcmMessage = {
    data,
    tokens,
    android: { priority: 'high' }
  };
  
  try {
    const response = await admin.messaging().sendEachForMulticast(fcmMessage);
    
    const deadTokensByUserId = new Map();
    const retryTokens = [];
    const results = [];
    
    let successCount = 0;
    let failureCount = 0;
    
    response.responses.forEach((resp, idx) => {
      const token = tokens[idx];
      const userId = tokenMap.get(token);
      
      if (resp.success) {
        successCount++;
        results.push({ userId, success: true, fcmMessageId: resp.messageId });
      } else {
        const errCode = resp.error?.code;
        if (errCode === 'messaging/invalid-registration-token' || errCode === 'messaging/registration-token-not-registered') {
           // Permanent error: queue for deletion
           if (!deadTokensByUserId.has(userId)) deadTokensByUserId.set(userId, []);
           deadTokensByUserId.get(userId).push(token);
           failureCount++;
           results.push({ userId, success: false, reason: errCode });
        } else {
           // Transient error: retry if attempts left
           if (attempt < MAX_RETRIES) {
             retryTokens.push(token);
           } else {
             failureCount++;
             results.push({ userId, success: false, reason: errCode });
           }
        }
      }
    });
    
    // Prune dead tokens in background (fire and forget)
    if (deadTokensByUserId.size > 0) {
      for (const [uid, dTokens] of deadTokensByUserId.entries()) {
        User.findByIdAndUpdate(uid, { $pullAll: { fcmTokens: dTokens } }).catch(e => console.error('[BroadcastFCM] Pruning error:', e.message));
      }
    }
    
    // Retry transient errors
    if (retryTokens.length > 0 && attempt < MAX_RETRIES) {
      console.log(`[BroadcastFCM] Retrying ${retryTokens.length} transient errors, attempt ${attempt+1}/${MAX_RETRIES}`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      const retryResult = await sendChunkWithRetry(retryTokens, title, body, data, tokenMap, attempt + 1);
      
      successCount += retryResult.successCount;
      failureCount += retryResult.failureCount;
      results.push(...retryResult.results);
    }
    
    return { successCount, failureCount, results };
    
  } catch (err) {
    console.error(`[BroadcastFCM] sendChunk error (attempt ${attempt}):`, err.message);
    if (attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      return sendChunkWithRetry(tokens, title, body, data, tokenMap, attempt + 1);
    } else {
      return { 
        successCount: 0, 
        failureCount: tokens.length, 
        results: tokens.map(t => ({ userId: tokenMap.get(t), success: false, reason: err.message }))
      };
    }
  }
}

module.exports = {
  sendToSingleUser,
  sendToMultipleUsers,
};
