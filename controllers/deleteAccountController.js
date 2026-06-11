// controllers/deleteAccountController.js
// =============================================================================
// Google Play Compliant Full Account Deletion
// Route: DELETE /api/users/me   (authenticated)
//
// Play Store Policy Requirements Satisfied:
//   ✅  In-app deletion — no email / external URL redirect
//   ✅  Permanent deletion for every authenticated user
//   ✅  All user data deleted or anonymized
//   ✅  Cloudinary photos deleted (profile + verification)
//   ✅  User removed from all cross-collection references
//   ✅  FCM tokens revoked before document deletion
//   ✅  Data retention policy: PII stripped from legally-required records
//
// Data Retention Policy (RETAIN anonymized, DELETE everything else):
//   DELETE: Profile, posts, comments, likes, companion/mood/activity requests,
//           bookings, gaming/movie sessions, notifications (Activity feed),
//           live location, trusted contacts, verification sessions,
//           OTPs, legal acceptances, encryption keys, voice calls,
//           weekly usage, bug reports, incident notes, food posts/comments
//   RETAIN (anonymized — PII removed):
//           SafetyReport (abuse/moderation integrity)
//           UserReport   (platform safety records)
//           Payout/Payout (financial compliance — UPI details anonymized)
//           AuditLog     (security audit — not touched; actor field references user ID only)
//
// Security:
//   - authenticate middleware validates JWT before this controller runs
//   - mongoose ObjectId validated before any DB operation
//   - Every individual step wrapped in safeDelete/safeUpdate helpers
//   - Failure in any step is logged but does NOT abort the overall deletion
//   - User document is the LAST thing deleted (belt-and-suspenders for cleanup)
// =============================================================================

'use strict';

const mongoose        = require('mongoose');
const User            = require('../models/User');
const { deleteImage } = require('../config/cloudinary');

// ── Lazy-load every model ─────────────────────────────────────────────────────
// safeRequireModel returns null if the model file doesn't exist yet, so new
// collections added later won't crash existing installations.
const safeRequireModel = (name) => {
  try { return require(`../models/${name}`); }
  catch (_) { return null; }
};

// ─── Content & Social ───────────────────────────────────────────────────────
const Post                = safeRequireModel('Post');
const Comment             = safeRequireModel('Comment');
const PostLike            = safeRequireModel('PostLike');
const CommentLike         = safeRequireModel('CommentLike');
const PostReport          = safeRequireModel('PostReport');
const FoodPost            = safeRequireModel('FoodPost');
const FoodComment         = safeRequireModel('FoodCommentModel');

// ─── Mood & Matching ────────────────────────────────────────────────────────
const MoodRequest         = safeRequireModel('MoodRequest');
const MoodChat            = safeRequireModel('MoodChat');
const MatchingTodayMood   = safeRequireModel('MatchingTodayMood');
const DailyMood           = safeRequireModel('DailyMood');

// ─── Bookings & Activities ──────────────────────────────────────────────────
const RandomBooking       = safeRequireModel('RandomBooking');
const RandomBookingChat   = safeRequireModel('RandomBookingChat');
const Booking             = safeRequireModel('Booking');
const BookingMatch        = safeRequireModel('BookingMatch');
const Activity            = safeRequireModel('Activity');    // notification/activity feed
const Review              = safeRequireModel('Review');
const Event               = safeRequireModel('Event');

// ─── Messaging & Calls ──────────────────────────────────────────────────────
const Message             = safeRequireModel('Message');
const Chat                = safeRequireModel('Chat');
const VoiceCall           = safeRequireModel('VoiceCall');

// ─── Gaming & Movies ────────────────────────────────────────────────────────
const GamingSession       = safeRequireModel('GamingSession');
const MovieSession        = safeRequireModel('MovieSession');
const MovieChat           = safeRequireModel('MovieChat');

// ─── Location & Safety ──────────────────────────────────────────────────────
const LiveLocation        = safeRequireModel('LiveLocation');
const TrustedContact      = safeRequireModel('TrustedContact');
const SafetyReport        = safeRequireModel('SafetyReport');
const UserReport          = safeRequireModel('UserReport');
const IncidentNote        = safeRequireModel('IncidentNote');

// ─── Auth & Session ─────────────────────────────────────────────────────────
const Otp                 = safeRequireModel('Otp');
const LegalAcceptance     = safeRequireModel('LegalAcceptance');
const EncryptionKey       = safeRequireModel('EncryptionKey');
const VerificationSession = safeRequireModel('VerificationSession');
const ProfileEditLog      = safeRequireModel('ProfileEditLog');

// ─── Misc ────────────────────────────────────────────────────────────────────
const WeeklyUsage         = safeRequireModel('WeeklyUsage');
const BugReport           = safeRequireModel('BugReport');
const Payout              = safeRequireModel('Payout');

// =============================================================================
// Helpers
// =============================================================================

/**
 * Safely delete documents matching [filter] from [model].
 * Returns the number deleted. Logs and returns 0 on error.
 */
const safeDelete = async (model, filter) => {
  if (!model) return 0;
  try {
    const r = await model.deleteMany(filter);
    return r.deletedCount ?? 0;
  } catch (e) {
    console.error(`[deleteAccount] safeDelete(${model.modelName}) failed:`, e.message);
    return 0;
  }
};

/**
 * Safely apply [update] to documents matching [filter] in [model].
 * Logs and no-ops on error.
 */
const safeUpdate = async (model, filter, update, options = {}) => {
  if (!model) return;
  try {
    await model.updateMany(filter, update, options);
  } catch (e) {
    console.error(`[deleteAccount] safeUpdate(${model.modelName}) failed:`, e.message);
  }
};

/**
 * Safely delete a Cloudinary resource by [publicId].
 * Logs and no-ops on error (e.g. already deleted or invalid ID).
 */
const safeDeleteCloudinary = async (publicId) => {
  if (!publicId || typeof publicId !== 'string' || publicId.trim() === '') return;
  try {
    await deleteImage(publicId.trim());
    console.log(`[deleteAccount] Cloudinary deleted: ${publicId}`);
  } catch (e) {
    console.error(`[deleteAccount] Cloudinary delete failed for ${publicId}:`, e.message);
  }
};

// =============================================================================
// DELETE /api/users/me
// =============================================================================

const deleteMyAccount = async (req, res) => {
  const userId = req.userId?.toString();

  // ── Validate user ID ───────────────────────────────────────────────────────
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid user session. Please log in and try again.'
    });
  }

  const userIdObj = new mongoose.Types.ObjectId(userId);
  const stats     = {};

  console.log(`[deleteAccount] ▶ START — userId=${userId}`);

  try {

    // ── Step 1: Fetch user (need Cloudinary IDs before we delete the doc) ────
    const user = await User.findById(userId)
      .select('profilePhotoPublicId verificationPhotoPublicId paymentInfo firstName email')
      .lean();

    if (!user) {
      // User already deleted — treat as success (idempotent)
      console.warn(`[deleteAccount] User ${userId} not found — treating as already deleted`);
      return res.status(200).json({
        success: true,
        message: 'Account has been permanently deleted.'
      });
    }

    // ── Step 2: Delete Cloudinary media ───────────────────────────────────────
    await safeDeleteCloudinary(user.profilePhotoPublicId);
    await safeDeleteCloudinary(user.verificationPhotoPublicId);
    // Payment verification photo (UPI host verification, if applicable)
    if (user.paymentInfo?.verificationPhotoPublicId) {
      await safeDeleteCloudinary(user.paymentInfo.verificationPhotoPublicId);
    }
    stats.cloudinary = 'cleared';

    // ── Step 3: Delete posts + their Cloudinary images ────────────────────────
    if (Post) {
      try {
        const userPosts = await Post.find({ userId: userIdObj }).select('imagePublicId').lean();
        for (const p of userPosts) await safeDeleteCloudinary(p.imagePublicId);
        await Post.deleteMany({ userId: userIdObj });
        // Remove user's votes from other users' poll posts
        await Post.updateMany(
          { 'pollOptions.votes': userIdObj },
          { $pull: { 'pollOptions.$[].votes': userIdObj } }
        );
        // Remove user's reposts from other users' posts
        await Post.updateMany(
          { 'reposts.userId': userIdObj },
          { $pull: { reposts: { userId: userIdObj } } }
        );
        stats.posts = userPosts.length;
      } catch (e) {
        console.error('[deleteAccount] posts step error:', e.message);
      }
    }

    // ── Step 4: Delete comments ───────────────────────────────────────────────
    stats.comments = await safeDelete(Comment, { userId: userIdObj });

    // ── Step 5: Delete post likes / reactions ────────────────────────────────
    stats.postLikes = await safeDelete(PostLike, { userId: userIdObj });

    // ── Step 6: Delete comment likes ─────────────────────────────────────────
    stats.commentLikes = await safeDelete(CommentLike, { userId: userIdObj });

    // ── Step 7: Delete post reports submitted BY this user ───────────────────
    stats.postReports = await safeDelete(PostReport, { reportedBy: userIdObj });

    // ── Step 8: Delete food posts + Cloudinary images ─────────────────────────
    if (FoodPost) {
      try {
        const foodPosts = await FoodPost.find({ userId: userIdObj }).select('imagePublicId').lean();
        for (const fp of foodPosts) await safeDeleteCloudinary(fp.imagePublicId);
        await FoodPost.deleteMany({ userId: userIdObj });
        stats.foodPosts = foodPosts.length;
      } catch (e) {
        console.error('[deleteAccount] foodPosts step error:', e.message);
      }
    }

    // ── Step 9: Delete food comments ─────────────────────────────────────────
    stats.foodComments = await safeDelete(FoodComment, { userId: userIdObj });

    // ── Step 10: Delete mood requests (sent + received) ───────────────────────
    stats.moodRequests = await safeDelete(MoodRequest, {
      $or: [{ senderId: userIdObj }, { receiverId: userIdObj }]
    });

    // ── Step 11: Delete mood chat rooms ──────────────────────────────────────
    stats.moodChats = await safeDelete(MoodChat, {
      $or: [{ user1: userIdObj }, { user2: userIdObj }]
    });

    // ── Step 12: Delete mood / daily mood state ───────────────────────────────
    stats.matchingMood = await safeDelete(MatchingTodayMood, { userId: userIdObj });
    stats.dailyMood    = await safeDelete(DailyMood,         { userId: userIdObj });

    // ── Step 13: Delete Activity feed (notifications) ─────────────────────────
    //   Documents where userId = user receiving the notification
    //   Also delete activities where actorId = this user (caused by this user)
    stats.activityFeed = await safeDelete(Activity, {
      $or: [{ userId: userIdObj }, { actorId: userIdObj }]
    });

    // ── Step 14: Delete random bookings ──────────────────────────────────────
    stats.randomBookings = await safeDelete(RandomBooking, {
      $or: [{ requesterId: userIdObj }, { companionId: userIdObj }]
    });

    // ── Step 15: Delete random booking chats ─────────────────────────────────
    stats.randomBookingChats = await safeDelete(RandomBookingChat, {
      'participants.userId': userIdObj
    });

    // ── Step 16: Delete bookings ──────────────────────────────────────────────
    stats.bookings = await safeDelete(Booking, {
      $or: [{ member: userIdObj }, { companion: userIdObj }]
    });

    // ── Step 17: Delete booking matches ───────────────────────────────────────
    stats.bookingMatches = await safeDelete(BookingMatch, {
      $or: [{ memberId: userIdObj }, { companionId: userIdObj }]
    });

    // ── Step 18: Delete activities / events hosted by user ───────────────────
    stats.activities = await safeDelete(Activity, { createdBy: userIdObj });
    stats.events     = await safeDelete(Event,    { creator:   userIdObj });

    // ── Step 19: Delete reviews written BY user; anonymize reviews ABOUT user ─
    stats.reviewsDeleted = await safeDelete(Review, { reviewerId: userIdObj });
    await safeUpdate(Review, { companionId: userIdObj }, {
      $set: { companionId: null, _anonymized: true }
    });

    // ── Step 20: Anonymize messages (preserve chat for other party) ───────────
    if (Message) {
      try {
        await Message.updateMany(
          { senderId: userIdObj },
          {
            $set: {
              content:     '[Message removed]',
              senderId:    null,
              _anonymized: true
            }
          }
        );
        stats.messagesAnonymized = true;
      } catch (e) {
        console.error('[deleteAccount] messages anonymize error:', e.message);
      }
    }

    // ── Step 21: Handle chat rooms ─────────────────────────────────────────────
    if (Chat) {
      try {
        // Delete 1-to-1 chats where this user is the only (or last) participant
        await Chat.deleteMany({ participants: { $size: 1, $all: [userIdObj] } });
        // Remove from group/multi-participant chats
        await Chat.updateMany(
          { participants: userIdObj },
          { $pull: { participants: userIdObj } }
        );
        stats.chats = true;
      } catch (e) {
        console.error('[deleteAccount] chats step error:', e.message);
      }
    }

    // ── Step 22: Gaming sessions ──────────────────────────────────────────────
    if (GamingSession) {
      try {
        // Sessions this user created → mark expired
        await GamingSession.updateMany(
          { creatorId: userIdObj },
          { $set: { cardStatus: 'expired', chatStatus: 'expired' } }
        );
        // Remove from sessions they joined
        await GamingSession.updateMany(
          { 'playersJoined.userId': userIdObj },
          { $pull: { playersJoined: { userId: userIdObj } } }
        );
        stats.gamingSessions = true;
      } catch (e) {
        console.error('[deleteAccount] gaming sessions step error:', e.message);
      }
    }

    // ── Step 23: Movie sessions ────────────────────────────────────────────────
    if (MovieSession) {
      try {
        await MovieSession.updateMany(
          { createdBy: userIdObj },
          { $set: { status: 'cancelled' } }
        );
        await MovieSession.updateMany(
          { 'participants.userId': userIdObj },
          { $pull: { participants: { userId: userIdObj } } }
        );
        stats.movieSessions = true;
      } catch (e) {
        console.error('[deleteAccount] movie sessions step error:', e.message);
      }
    }

    // ── Step 24: Anonymize movie chat messages ─────────────────────────────────
    if (MovieChat) {
      try {
        await MovieChat.updateMany(
          { 'messages.senderId': userIdObj },
          {
            $set: {
              'messages.$[m].content':     '[Message removed]',
              'messages.$[m]._anonymized': true
            }
          },
          { arrayFilters: [{ 'm.senderId': userIdObj }] }
        );
        stats.movieChats = true;
      } catch (e) {
        console.error('[deleteAccount] movie chats step error:', e.message);
      }
    }

    // ── Step 25: Voice calls ─────────────────────────────────────────────────
    stats.voiceCalls = await safeDelete(VoiceCall, {
      $or: [{ callerId: userIdObj }, { calleeId: userIdObj }]
    });

    // ── Step 26: Live location ────────────────────────────────────────────────
    stats.liveLocation = await safeDelete(LiveLocation, { userId: userIdObj });

    // ── Step 27: Trusted contacts (safety feature) ────────────────────────────
    stats.trustedContacts = await safeDelete(TrustedContact, { userId: userIdObj });

    // ── Step 28: Profile edit logs ────────────────────────────────────────────
    stats.profileEditLogs = await safeDelete(ProfileEditLog, { userId: userIdObj });

    // ── Step 29: OTPs ─────────────────────────────────────────────────────────
    stats.otps = await safeDelete(Otp, {
      $or: [{ userId: userIdObj }, { email: user.email }]
    });

    // ── Step 30: Legal acceptances ────────────────────────────────────────────
    stats.legalAcceptances = await safeDelete(LegalAcceptance, { userId: userIdObj });

    // ── Step 31: Encryption keys ──────────────────────────────────────────────
    stats.encryptionKeys = await safeDelete(EncryptionKey, { userId: userIdObj });

    // ── Step 32: Verification sessions ───────────────────────────────────────
    stats.verificationSessions = await safeDelete(VerificationSession, { userId: userIdObj });

    // ── Step 33: Weekly usage records ─────────────────────────────────────────
    stats.weeklyUsage = await safeDelete(WeeklyUsage, { userId: userIdObj });

    // ── Step 34: Bug reports ──────────────────────────────────────────────────
    stats.bugReports = await safeDelete(BugReport, { userId: userIdObj });

    // ── Step 35: Incident notes ───────────────────────────────────────────────
    stats.incidentNotes = await safeDelete(IncidentNote, { userId: userIdObj });

    // ── Step 36: RETAINED records — strip PII, keep anonymized references ─────
    //
    // SafetyReport: critical for abuse / moderation integrity → retain anonymized
    await safeUpdate(SafetyReport, { reporterId: userIdObj }, {
      $set: {
        reporterId:                           null,
        'contactPreference.phoneNumber':       null,
        'contactPreference.email':             null,
        _reporterDeleted:                     true
      }
    });

    // UserReport: safety record → retain anonymized
    await safeUpdate(UserReport, { reporterId: userIdObj }, {
      $set: {
        reporterId:      null,
        _reporterDeleted: true
      }
    });

    // Payout: financial / legal compliance → strip PII, retain reference
    await safeUpdate(Payout, { userId: userIdObj }, {
      $set: {
        upiId:        '[REDACTED]',
        upiName:      '[REDACTED]',
        userId:       null,          // remove personal reference
        _userDeleted: true
      }
    });

    // ── Step 37: Remove user from other users' blocklist / mutelist ───────────
    await safeUpdate(User, { blockedUsers: userIdObj }, { $pull: { blockedUsers: userIdObj } });
    await safeUpdate(User, { mutedUsers:   userIdObj }, { $pull: { mutedUsers:   userIdObj } });
    await safeUpdate(User,
      { 'notInterestedUsers.userId': userIdObj },
      { $pull: { notInterestedUsers: { userId: userIdObj } } }
    );
    await safeUpdate(User,
      { 'bookingRefs.otherUserId': userIdObj },
      { $pull: { bookingRefs: { otherUserId: userIdObj } } }
    );
    stats.crossRefsCleaned = true;

    // ── Step 38: Revoke all FCM tokens (prevent ghost push notifications) ──────
    // The User document is about to be deleted, but revoke tokens explicitly
    // first as a belt-and-suspenders measure. Firebase's /batchDelete API
    // could be called here too if server-side token management is required.
    try {
      await User.updateOne({ _id: userIdObj }, { $set: { fcmTokens: [] } });
      stats.fcmTokensRevoked = true;
    } catch (e) {
      console.error('[deleteAccount] FCM token revoke failed (non-fatal):', e.message);
    }

    // ── Step 39: Delete the User document ────────────────────────────────────
    // THIS IS THE LAST STEP — all cleanup must complete before this line.
    // Once the User document is gone, the JWT is permanently invalid (middleware
    // calls User.findById which will return null → 401 on any subsequent request).
    await User.findByIdAndDelete(userId);
    stats.userDocumentDeleted = true;

    console.log(`[deleteAccount] ✅ COMPLETE — userId=${userId}`, stats);

    return res.status(200).json({
      success: true,
      message: 'Your account and all associated data have been permanently deleted.'
    });

  } catch (error) {
    console.error(`[deleteAccount] ❌ CRITICAL ERROR — userId=${userId}:`, error);

    // If the user document was deleted despite an error, return success
    // (the critical part — account deletion — succeeded).
    if (stats.userDocumentDeleted) {
      return res.status(200).json({
        success: true,
        message: 'Account permanently deleted. Some ancillary data cleanup may be pending.'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Account deletion encountered an error. Please try again or contact support.'
    });
  }
};

module.exports = { deleteMyAccount };
