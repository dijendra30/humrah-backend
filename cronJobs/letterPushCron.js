const cron = require('node-cron');
const mongoose = require('mongoose');
const pushService = require('../services/push.service');
const LetterNotification = require('../models/LetterNotification');

// Runs every 15 minutes
const startLetterPushCron = () => {
  cron.schedule('*/15 * * * *', async () => {
    try {
      // 1. Check Quiet Hours (11:00 PM - 8:00 AM IST)
      const nowIST = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
      const currentHour = parseInt(nowIST, 10);
      
      // Quiet hours: 23 (11 PM) or 0-7 (12 AM - 7:59 AM)
      if (currentHour >= 23 || currentHour < 8) {
        console.log('[letterPushCron] Quiet hours active. Skipping push summary.');
        return;
      }

      console.log('[letterPushCron] Checking for batched letter notifications...');

      // 2. Find pending pushes
      const pendingNotifications = await LetterNotification.find({ pendingPushCount: { $gt: 0 } });
      if (!pendingNotifications || pendingNotifications.length === 0) {
        return;
      }

      // 3. Group by letterId
      const batchedByLetter = {};
      pendingNotifications.forEach(notif => {
        const letterStr = notif.letterId.toString();
        if (!batchedByLetter[letterStr]) {
          batchedByLetter[letterStr] = {
            recipientId: notif.recipientId,
            comfortCount: 0,
            warmthCount: 0,
            notificationIds: []
          };
        }
        
        if (notif.type === 'comfort' || notif.type === 'helped') {
          batchedByLetter[letterStr].comfortCount += notif.pendingPushCount;
        } else if (notif.type === 'warmth') {
          batchedByLetter[letterStr].warmthCount += notif.pendingPushCount;
        }
        batchedByLetter[letterStr].notificationIds.push(notif._id);
      });

      // 4. Send summaries and reset counts
      for (const [letterId, data] of Object.entries(batchedByLetter)) {
        await pushService.sendSummaryNotification(data.recipientId, letterId, data.comfortCount, data.warmthCount);

        // Reset pendingPushCount for these notifications
        await LetterNotification.updateMany(
          { _id: { $in: data.notificationIds } },
          { $set: { pendingPushCount: 0, lastPushAt: new Date() } }
        );
      }

      console.log(`[letterPushCron] Sent summaries for ${Object.keys(batchedByLetter).length} letters.`);

    } catch (err) {
      console.error('[letterPushCron] Error executing job:', err);
    }
  });
};

module.exports = { startLetterPushCron };
