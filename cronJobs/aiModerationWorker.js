// cronJobs/aiModerationWorker.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const ModerationTask = require('../models/ModerationTask');
const User = require('../models/User');
const Activity = require('../models/Activity');
const ModerationLog = require('../models/ModerationLog');
const ModerationCache = require('../models/ModerationCache');
const { checkWithOpenAI, checkWithLlamaGuard } = require('../middleware/moderation');

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

const L1_PATTERNS = [
  /whatsapp/i, /telegram/i, /instagram/i, /snapchat/i, /facebook/i, /onlyfans/i, /discord/i,
  /[6-9]\d{9}/, /\b\d{10,}\b/,
  /\b(call\s*me|text\s*me|dm\s*me|message\s*me|contact\s*me)\b/i,
  /\b(reach\s*(?:me|out)|hit\s*me\s*up|ping\s*me|slide\s*in(?:to)?\s*(?:my|the))\b/i,
  /\b(my\s*(?:number|no\.?|num|contact|handle|id)\s*(?:is|:))/i,
  /\b(find\s*me\s*on|add\s*me\s*on|follow\s*me\s*on)\b/i,
  /\b(wtf|damn|crap|bloody\s+hell|shut\s+up|stupid)\b/i,
  /investment/i, /crypto/i, /scam/i, /guaranteed\s*returns/i, /send\s*money/i
];

let _activeWorkerCount = 0;
const MAX_CONCURRENT_MODERATIONS = 3;

async function processTask(task) {
  let finalDecision = 'APPROVE';
  let providerUsed = 'Multiple';
  let openAiRes = null;
  let llamaRes = null;
  let ruleRes = null;

  try {
    const textsForAI = {};
    task.fields.forEach(f => { textsForAI[f.path] = f.value; });
    const contentString = Object.entries(textsForAI).map(([f, t]) => `[${f}]: ${t}`).join('\n---\n');
    const contentHash = crypto.createHash('sha256').update(contentString).digest('hex');

    // 1. Check Cache
    const cached = await ModerationCache.findOne({ contentHash });
    if (cached) {
      providerUsed = 'Cache';
      finalDecision = cached.decision;
      openAiRes = cached.openAiResult;
      llamaRes = cached.llamaGuardResult;
      ruleRes = cached.ruleEngineResult;
    } else {
      // 2. Humrah Rule Engine
      let hasL1Violation = false;
      let flaggedFields = [];
      task.fields.forEach(f => { 
        const normalized = f.value.replace(/\s+/g, '').toLowerCase();
        if (L1_PATTERNS.some(p => p.test(f.value) || p.test(normalized))) {
          hasL1Violation = true;
          flaggedFields.push(f.path);
        }
      });

      if (hasL1Violation) {
        ruleRes = { flagged: true, fields: flaggedFields };
        finalDecision = 'REVIEW';
      } else {
        ruleRes = { flagged: false };
      }

      // 3. OpenAI (Concurrency 1 enforced inside middleware)
      if (finalDecision !== 'REJECT') {
        const aiResult = await checkWithOpenAI(textsForAI);
        openAiRes = aiResult;
        if (!aiResult.safe) {
          finalDecision = 'REJECT';
          flaggedFields = task.fields.map(f => f.path);
        }
      }

      // 4. Llama Guard (Concurrency 3 enforced inside middleware)
      if (finalDecision !== 'REJECT') {
        const llamaResult = await checkWithLlamaGuard(textsForAI);
        llamaRes = llamaResult;
        if (!llamaResult.safe) {
          finalDecision = 'REVIEW';
        }
      }

      // Save Cache
      await ModerationCache.updateOne(
        { contentHash },
        { contentHash, decision: finalDecision, openAiResult: openAiRes, llamaGuardResult: llamaRes, ruleEngineResult: ruleRes },
        { upsert: true }
      );
    }

    // Save Log
    await ModerationLog.create({
      userId: task.userId,
      contentHash,
      providerUsed,
      openAiResult: openAiRes,
      llamaGuardResult: llamaRes,
      ruleEngineResult: ruleRes,
      finalDecision,
      retryCount: task.retryCount
    });

    const user = await User.findById(task.userId);
    if (!user) {
      await ModerationTask.findByIdAndUpdate(task._id, { status: 'completed' });
      return;
    }

    if (finalDecision === 'REJECT') {
      // Level 3 (Severe) Action
      user.moderationStatus = 'flagged';
      if (!user.flaggedFields) user.flaggedFields = [];
      let flaggedPaths = ruleRes?.fields || task.fields.map(f => f.path);
      flaggedPaths.forEach(p => { if (!user.flaggedFields.includes(p)) user.flaggedFields.push(p); });
      
      user.restrictedUntil = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000); 
      user.restrictionReason = "Severe violation detected. Pending Safety Team review.";
      await user.save();

      await Activity.create({
        userId: user._id,
        actorId: SYSTEM_USER_ID,
        actorName: 'Humrah Safety System',
        type: 'WARNING',
        message: 'Your account has been restricted due to a severe violation of our community guidelines. A manual review has been requested.'
      });
      console.log(`[MODERATION] User ${user._id} REJECTED.`);

    } else if (finalDecision === 'REVIEW') {
      // Level 1 (Minor) Action
      user.moderationStatus = 'flagged';
      if (!user.flaggedFields) user.flaggedFields = [];
      let flaggedPaths = ruleRes?.fields || task.fields.map(f => f.path);
      flaggedPaths.forEach(p => { if (!user.flaggedFields.includes(p)) user.flaggedFields.push(p); });

      if (!user.moderationFlags) user.moderationFlags = {};
      if (!user.moderationFlags.violations) user.moderationFlags.violations = [];
      
      user.moderationFlags.violations.push({ level: 1, detectedAt: new Date() });

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const activeL1Offenses = user.moderationFlags.violations.filter(v => v.level === 1 && v.detectedAt > thirtyDaysAgo).length;

      if (activeL1Offenses >= 3) {
        const restrictionHours = 12;
        user.restrictedUntil = new Date(Date.now() + restrictionHours * 60 * 60 * 1000);
        user.restrictionReason = "Repeated minor violations.";
        await Activity.create({
          userId: user._id,
          actorId: SYSTEM_USER_ID,
          actorName: 'Humrah Safety System',
          type: 'WARNING',
          message: `You have been temporarily restricted from editing your profile for ${restrictionHours} hours due to repeated community guideline violations.`
        });
        console.log(`[MODERATION] User ${user._id} escalated to REVIEW (12h ban).`);
      } else {
        await Activity.create({
          userId: user._id,
          actorId: SYSTEM_USER_ID,
          actorName: 'Humrah Safety System',
          type: 'WARNING',
          message: 'Part of your profile was hidden because it may contain external contact info or violate guidelines. Please review and update.'
        });
        console.log(`[MODERATION] User ${user._id} REVIEW.`);
      }
      await user.save();

    } else {
      // Clean
      const pendingCount = await ModerationTask.countDocuments({
        userId: user._id,
        status: { $in: ['pending', 'processing'] }
      });

      if (pendingCount <= 1) {
        user.moderationStatus = 'clean';
        user.flaggedFields = [];
        await user.save();
      }
    }

    await ModerationTask.findByIdAndUpdate(task._id, { status: 'completed' });

  } catch (err) {
    console.error(`[MODERATION] Task ${task._id} failed:`, err.message);
    
    // 429 Retry Logic Backoff: 60s -> 120s -> 300s
    let backoffMs = 60 * 1000;
    if (task.retryCount === 1) backoffMs = 120 * 1000;
    else if (task.retryCount === 2) backoffMs = 300 * 1000;

    if (task.retryCount < 3) {
      await ModerationTask.findByIdAndUpdate(task._id, {
        $inc: { retryCount: 1 },
        $set: { 
          status: 'pending', 
          lastError: err.message,
          nextAttemptAt: new Date(Date.now() + backoffMs)
        }
      });
      console.log(`[MODERATION] Task ${task._id} requeued for retry ${task.retryCount + 1} in ${backoffMs/1000}s`);
    } else {
      await ModerationTask.findByIdAndUpdate(task._id, {
        status: 'failed_permanently',
        lastError: err.message
      });
      await User.findByIdAndUpdate(task.userId, {
        moderationStatus: 'pending_review'
      });
      console.error(`[MODERATION] Task ${task._id} permanently failed after 3 tries. User set to pending_review.`);
    }
  } finally {
    _activeWorkerCount--;
  }
}

async function runModerationWorker() {
  await ensureSystemUser().catch(err => console.error('[MODERATION] Failed to ensure system user', err));

  setInterval(async () => {
    if (_activeWorkerCount >= MAX_CONCURRENT_MODERATIONS) return;

    try {
      const limit = MAX_CONCURRENT_MODERATIONS - _activeWorkerCount;
      const tasks = await ModerationTask.find({ 
        status: 'pending', 
        nextAttemptAt: { $lte: new Date() } 
      }).limit(limit);
      
      if (tasks.length === 0) return;

      const taskIds = tasks.map(t => t._id);
      await ModerationTask.updateMany({ _id: { $in: taskIds } }, { $set: { status: 'processing' } });

      for (const task of tasks) {
        _activeWorkerCount++;
        processTask(task); // non-blocking execution to allow concurrency
      }
    } catch (error) {
      console.error('[MODERATION] Worker loop error:', error);
    }
  }, 3000); // Check every 3s
}

module.exports = runModerationWorker;
