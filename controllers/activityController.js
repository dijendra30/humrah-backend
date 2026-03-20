// controllers/activityController.js
// Handles Activity Feed — creation, aggregation (anti-spam), read state.
//
// Spec rules:
//   LIKE_*    → aggregated within 30-min window — NO push
//   COMMENT_* → single entry — COMMENT_FOOD pushes via gamingPush.js
//   JOIN_GAMING → single entry — pushes via gamingPush.js
//   WARNING   → always single entry — always pushes
//   SYSTEM    → optional push
//
// Public API:
//   createOrAggregateActivity(params)  — called by food/post/gaming controllers
//   exports.getActivities              — GET  /api/activity
//   exports.markRead                   — PATCH /api/activity/read/:id
//   exports.markAllRead                — PATCH /api/activity/read-all

const Activity = require('../models/Activity');
const User     = require('../models/User');

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────

const AGGREGATION_WINDOW_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_MS         = 10 * 1000;       // 10-second per-user cooldown

// ─────────────────────────────────────────────────────────────
//  MESSAGE BUILDERS
// ─────────────────────────────────────────────────────────────

function buildMessage(type, actorName) {
  switch (type) {
    case 'LIKE_POST':     return `${actorName} liked your post`;
    case 'COMMENT_POST':  return `${actorName} commented on your post`;
    case 'LIKE_FOOD':     return `${actorName} liked your food post`;
    case 'COMMENT_FOOD':  return `${actorName} commented on your food post`;
    case 'LIKE_GAMING':   return `${actorName} liked your gaming session`;
    case 'JOIN_GAMING':   return `${actorName} joined your gaming session`;
    case 'WARNING':       return '⚠ Your post violates community guidelines. Please edit or remove it.';
    case 'SYSTEM':        return 'You have a new system notification';
    default:              return 'New activity on your post';
  }
}

function buildAggregatedMessage(type, firstName, count) {
  const others = count - 1;
  if (others <= 0) return buildMessage(type, firstName);
  const label = type.includes('FOOD') ? 'food post' : 'post';
  return `${firstName} and ${others} other${others > 1 ? 's' : ''} liked your ${label}`;
}

// ─────────────────────────────────────────────────────────────
//  CORE INTERNAL HELPER
// ─────────────────────────────────────────────────────────────

/**
 * Called by foodController, posts.js, gamingController.
 * Fire-and-forget: callers should .catch(err => console.error(...))
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId      - receiver
 * @param {string|ObjectId} params.actorId     - who triggered the action
 * @param {string}          params.type        - activity type enum
 * @param {string}          params.entityType  - 'post' | 'food_post' | 'gaming_session'
 * @param {string|ObjectId} params.entityId
 * @param {string|null}     params.entityImage - thumbnail URL (optional)
 * @param {string|null}     params.message     - override message (optional)
 */
async function createOrAggregateActivity({
  userId,
  actorId,
  type,
  entityType = 'post',
  entityId,
  entityImage = null,
  message = null,
}) {
  // 1. Skip self-activity
  if (userId.toString() === actorId.toString()) return null;

  // 2. Rate limit — 1 activity per actor per action per 10s
  const tenSecondsAgo = new Date(Date.now() - RATE_LIMIT_MS);
  const veryRecent = await Activity.findOne({
    userId, actorId, type, entityId,
    createdAt: { $gte: tenSecondsAgo },
  }).lean();
  if (veryRecent) return null;

  // 3. Aggregation for likes only
  const isLike = type.startsWith('LIKE_');
  if (isLike) {
    const windowStart = new Date(Date.now() - AGGREGATION_WINDOW_MS);
    const existing = await Activity.findOne({
      userId, type, entityId,
      createdAt: { $gte: windowStart },
    });
    if (existing) {
      const alreadyIn = existing.meta.previewUsers
        .map(String)
        .includes(actorId.toString());
      if (alreadyIn) return existing;

      existing.meta.count += 1;
      if (existing.meta.previewUsers.length < 3) {
        existing.meta.previewUsers.push(actorId);
      }
      // Re-build the aggregated message using the FIRST actor's stored name
      existing.message = buildAggregatedMessage(type, existing.actorName, existing.meta.count);
      existing.isRead  = false; // mark unread again on new actor
      await existing.save();
      return existing;
    }
  }

  // 4. Fetch actor display info (snapshot)
  const actor = await User.findById(actorId)
    .select('firstName lastName profilePhoto')
    .lean();
  const actorName  = actor
    ? `${actor.firstName} ${actor.lastName || ''}`.trim()
    : 'Someone';
  const actorPhoto = actor?.profilePhoto || null;

  // 5. Create fresh activity
  return Activity.create({
    userId,
    actorId,
    actorName,
    actorPhoto,
    type,
    entityType,
    entityId,
    entityImage,
    message: message || buildMessage(type, actorName),
    meta: { count: 1, previewUsers: [actorId] },
    isRead: false,
  });
}

// ─────────────────────────────────────────────────────────────
//  ROUTE HANDLERS
// ─────────────────────────────────────────────────────────────

// GET /api/activity?page=1&limit=20
exports.getActivities = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const [activities, unreadCount] = await Promise.all([
      Activity.find({ userId: req.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Activity.countDocuments({ userId: req.userId, isRead: false }),
    ]);

    res.json({
      success:     true,
      activities,
      unreadCount,
      page,
      hasMore: activities.length === limit,
    });
  } catch (err) {
    console.error('[Activity] getActivities:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /api/activity/read/:id
exports.markRead = async (req, res) => {
  try {
    await Activity.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { isRead: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Activity] markRead:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /api/activity/read-all
exports.markAllRead = async (req, res) => {
  try {
    await Activity.updateMany(
      { userId: req.userId, isRead: false },
      { isRead: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Activity] markAllRead:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Export helper for use in other controllers
exports.createOrAggregateActivity = createOrAggregateActivity;
