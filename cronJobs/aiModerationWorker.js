// cronJobs/aiModerationWorker.js
const mongoose = require('mongoose');
const ModerationTask = require('../models/ModerationTask');
const User = require('../models/User');
const Activity = require('../models/Activity');
const { checkWithOpenAI } = require('../middleware/moderation');

let SYSTEM_USER_ID = null;

async function ensureSystemUser() {
  let existing = await User.findOne({ email: 'safety@humrah.in' });
  if (!existing) {
    existing = await User.create({
      firstName: 'Humrah Safety',
      lastName: 'System',
      email: 'safety@humrah.in',
      password: 'no-login-allowed',
      verified: true
    });
  }
  SYSTEM_USER_ID = existing._id;
}

async function runModerationWorker() {
  let isRunning = false;
  
  // Ensure the system user exists once before we start polling
  await ensureSystemUser().catch(err => console.error('[MODERATION] Failed to ensure system user', err));

  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      // 1. Fetch up to 10 pending tasks
      const tasks = await ModerationTask.find({ status: 'pending' }).limit(10);
      
      if (tasks.length === 0) {
        isRunning = false;
        return;
      }

      // Mark them as processing
      const taskIds = tasks.map(t => t._id);
      await ModerationTask.updateMany({ _id: { $in: taskIds } }, { $set: { status: 'processing' } });

      for (const task of tasks) {
        try {
          // 2. Build the map for checkWithOpenAI
          // OpenAI can check multiple fields at once
          const textsForAI = {};
          task.fields.forEach(f => { textsForAI[f.path] = f.value; });

          // 3. Call OpenAI (wait up to 10 seconds per task)
          // Since it's a background worker, we don't need a strict 5s timeout, but 10s is safe.
          const aiResult = await Promise.race([
            checkWithOpenAI(textsForAI),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 10000))
          ]);

          const user = await User.findById(task.userId);
          if (!user) {
            // User deleted their account, just complete the task
            await ModerationTask.findByIdAndUpdate(task._id, { status: 'completed' });
            continue;
          }

          if (!aiResult.safe) {
            // 4. Content is FLAGGED
            user.moderationStatus = 'flagged';
            
            // Add all flagged paths to user's flaggedFields array without duplicates
            if (!user.flaggedFields) user.flaggedFields = [];
            task.fields.forEach(f => {
              if (!user.flaggedFields.includes(f.path)) {
                user.flaggedFields.push(f.path);
              }
            });

            await user.save();

            // Create notification in Activity Feed
            await Activity.create({
              userId: user._id,
              actorId: SYSTEM_USER_ID,
              actorName: 'Humrah Safety System',
              type: 'WARNING',
              message: 'Part of your profile was hidden because it may violate Humrah Community Guidelines. Please review and update the highlighted section.'
            });

            // Send FCM Push Notification
            if (user.fcmTokens && user.fcmTokens.length > 0) {
              const { sendDataFcm } = require('../utils/fcmHelper');
              await sendDataFcm(user._id.toString(), user.fcmTokens, {
                type: 'SYSTEM_WARNING',
                title: 'Community Guidelines Notice',
                body: 'Part of your profile was hidden for review. Tap to see details.'
              });
            }

            await ModerationTask.findByIdAndUpdate(task._id, { status: 'completed' });
            console.log(`[MODERATION] User ${user._id} flagged for fields: ${task.fields.map(f=>f.path).join(', ')}`);

          } else {
            // 5. Content is SAFE
            await ModerationTask.findByIdAndUpdate(task._id, { status: 'completed' });

            // Are there any other pending/processing tasks for this user?
            const pendingCount = await ModerationTask.countDocuments({
              userId: user._id,
              status: { $in: ['pending', 'processing'] }
            });

            if (pendingCount === 0) {
              // If no other tasks are pending, clear the flagged state
              user.moderationStatus = 'clean';
              user.flaggedFields = [];
              await user.save();
              console.log(`[MODERATION] User ${user._id} profile clean.`);
            }
          }
        } catch (err) {
          console.error(`[MODERATION] Task ${task._id} failed:`, err.message);
          
          if (task.retryCount < 2) {
            // Requeue
            await ModerationTask.findByIdAndUpdate(task._id, {
              $inc: { retryCount: 1 },
              $set: { status: 'pending', lastError: err.message }
            });
          } else {
            // Fail task permanently
            await ModerationTask.findByIdAndUpdate(task._id, {
              status: 'failed',
              lastError: err.message
            });
            console.error(`[MODERATION] Task ${task._id} permanently failed after 3 tries.`);
          }
        }
      }

    } catch (error) {
      console.error('[MODERATION] Worker loop error:', error);
    }

    isRunning = false;
  }, 10000); // Run every 10 seconds
}

module.exports = runModerationWorker;
