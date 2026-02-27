// middleware/moderateMessage.js
// ─────────────────────────────────────────────────────────────────────────────
// Express middleware for chat message moderation.
// Supports OPTIMISTIC UI: message is saved and sent to recipient immediately,
// then this runs async. If rejected, a socket event deletes it client-side.
//
// HOW OPTIMISTIC UI WORKS:
//   1. Android sends message → server saves it instantly → emits to recipient
//   2. This middleware runs in background
//   3. If violation found:
//      a. Message is deleted from DB (or marked deleted)
//      b. Socket event 'message_moderated' sent to both sender and recipient
//      c. Android removes the message from UI on receiving that event
//   4. Sender gets structured error with enforcement info
//
// USAGE in routes/messages.js:
//   router.post('/send', authenticate, moderateMessageMiddleware, async (req, res) => { ... })
// ─────────────────────────────────────────────────────────────────────────────

const User = require('../models/User');
const { moderateChatMessage, applyStrikesAndEnforce, LEVEL } = require('./moderation');

/**
 * Synchronous pre-check middleware.
 * Runs BEFORE saving the message.
 * Regex-only (fast) — rejects obvious violations immediately.
 * AI check happens in the async post-save background job.
 */
async function moderateMessageMiddleware(req, res, next) {
  try {
    const { content } = req.body;
    if (!content || typeof content !== 'string') return next();

    const result = await moderateChatMessage(content);

    if (!result.allowed) {
      // ── Violation found — apply strikes before rejecting ──────
      const user = await User.findById(req.userId);
      let enforcement = { enforced: false, action: null, message: null, suspendUntil: null };

      if (user && result.violations.length > 0) {
        enforcement = await applyStrikesAndEnforce(user, result.violations, 'POST /api/messages/send');
      }

      return res.status(422).json({
        success: false,
        code:    'MESSAGE_MODERATED',
        message: result.userMessage || "This message violates our community guidelines.",
        level:   result.level,
        enforcement: enforcement.enforced ? {
          action:       enforcement.action,
          message:      enforcement.message,
          suspendUntil: enforcement.suspendUntil?.toISOString() || null,
        } : null,
      });
    }

    // ── Message passed — attach cleaned version to request ──────
    req.body.content          = result.cleanedText;
    req.moderationResult      = result;  // available in route handler if needed
    next();

  } catch (err) {
    // Fail-open: if moderation crashes, let the message through
    console.error('[MODERATION] Chat middleware error (fail-open):', err.message);
    next();
  }
}

module.exports = { moderateMessageMiddleware };
