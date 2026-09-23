// services/meetupSafetyReminderService.js
//
// Meetup safety lifecycle for accepted Surprise Activities:
//
//   startTime − 30 min  →  "your meetup is coming up"     (trusted contact / safety tips)
//   startTime − 10 min  →  "starts in 10 minutes"          (share live location)
//   endTime   + 10 min  →  "how did it go?"                (optional feedback)
//
// ── WHY A CRON TICK RATHER THAN A SCHEDULED JOB ───────────────────────────────
// There is no delayed-job system, queue or Redis scheduler in this codebase. What
// exists is node-cron in cronJobs.js, which already runs an every-minute tick for
// Surprise Meetup reservation expiry. This reuses that rather than adding a second
// scheduling mechanism.
//
// It also satisfies the hard requirements that in-process timers cannot:
//   • survives a server restart — cron re-registers on boot and ALL state is in Mongo
//   • no per-meetup process, no unbounded fan-out — one indexed query per tick
//   • no polling of users — the query is on bookings, bounded by a startTime range
//
// Cost: ±60s precision. That is why no notification states a clock time; the copy
// says "in about 30 minutes".
//
// ── WHY THERE IS NO SCHEDULED PAYLOAD ─────────────────────────────────────────
// Nothing is queued ahead of time, so there is no stale payload to distrust. Every
// tick re-reads the booking and re-checks its live status. A cancelled, expired or
// no-longer-accepted activity is simply never selected.
//
// ── TIMEZONE ──────────────────────────────────────────────────────────────────
// Deliberately none. startTime and endTime are UTC Date objects and every decision
// here is millisecond arithmetic on them, so this is DST-proof and region-proof by
// construction. IST is a display concern and does not appear in this file.

'use strict';

const RandomBooking  = require('../models/RandomBooking');
const TrustedContact = require('../models/TrustedContact');
const User           = require('../models/User');
const { sendDataFcm } = require('../utils/fcmHelper');

const MIN = 60 * 1000;

// How long after a reminder falls due it may still be sent. A brief outage should not
// silently drop a reminder, but nobody should be told a meetup "starts in 10 minutes"
// half an hour late — so each window closes when its message stops being true.
const THIRTY_MIN_BEFORE = 30 * MIN;
const TEN_MIN_BEFORE    = 10 * MIN;
const FEEDBACK_DELAY    = 10 * MIN;   // after endTime — never at endTime itself
const FEEDBACK_WINDOW   = 24 * 60 * MIN;

// Bounds the scan. Covers both the pre-meetup window ahead of now and the feedback
// window behind it, and uses the existing { status: 1, startTime: 1 } index.
const SCAN_BEHIND = 26 * 60 * MIN;
const SCAN_AHEAD  = 35 * MIN;

// Mirrors CATEGORY_PLAN_LABEL in utils/surpriseMeetupMatcher.js and the copy map in the
// Android FCM service. Falls back to the generic word, which is what every booking
// created before activityCategory existed will use.
const CATEGORY_PLAN_LABEL = {
  CAFE: 'coffee plan', FOOD: 'food plan', STREET_FOOD: 'street food plan',
  SHOPPING: 'shopping plan', WALK: 'walk', EXPLORE: 'plan to explore',
  ART_CULTURE: 'art & culture plan', NATURE: 'outdoors plan', BEACH: 'beach plan',
  HANGOUT: 'hangout', STUDY_WORK: 'study session', PHOTOGRAPHY: 'photography plan',
};

/**
 * Notification copy.
 *
 * Tone rules these follow: warm, plain, and never alarming. Nothing here implies the
 * other person is a risk, nothing invents urgency, nothing shames a user who declines.
 * Every suggestion is phrased as a choice ("consider", "if you'd like").
 */
function buildCopy(reminderType, otherName, hasTrustedContact, planLabel) {
  const who = otherName || 'someone';

  if (reminderType === 'THIRTY_MINUTE') {
    return hasTrustedContact
      ? {
          title: `Your meetup with ${who} is coming up`,
          body:  'Here are a few simple safety reminders before you head out.',
          safetyAction: 'SAFETY_TIPS',
        }
      : {
          title: `Your meetup with ${who} is coming up`,
          body:  'In about 30 minutes. Consider adding a trusted contact so you can quickly share your location if you ever want to.',
          safetyAction: 'TRUSTED_CONTACT',
        };
  }

  if (reminderType === 'TEN_MINUTE') {
    return {
      title: `Your meetup with ${who} starts in 10 minutes`,
      body:  'For peace of mind, consider sharing your live location with someone you trust.',
      safetyAction: 'SHARE_LOCATION',
    };
  }

  // POST_MEETUP_FEEDBACK
  return {
    title: `How did your ${planLabel} with ${who} go?`,
    body:  'Your feedback helps us make Humrah better. It only takes a moment.',
    safetyAction: 'RATE',
  };
}

/**
 * Atomically claim a reminder for one participant.
 *
 * The $ne guard makes this a claim rather than a write: only the caller that flips the
 * array from "absent" to "present" gets a document back. A repeated cron run, or two
 * server instances ticking simultaneously, cannot both send.
 *
 * Claim-before-send is deliberate. The alternative — send, then record — double-sends
 * whenever the process dies between the two, and a duplicate safety nudge is worse than
 * a missed one.
 *
 * @returns {Promise<boolean>} true if this caller won the claim.
 */
async function claimReminder(bookingId, field, userId) {
  const claimed = await RandomBooking.findOneAndUpdate(
    { _id: bookingId, [`safetyReminders.${field}`]: { $ne: userId } },
    { $push: { [`safetyReminders.${field}`]: userId } },
    { new: false, projection: { _id: 1 } }
  ).lean();
  return !!claimed;
}

/** Release a claim when the send could not be attempted at all, so the next tick retries. */
async function releaseReminder(bookingId, field, userId) {
  await RandomBooking.updateOne(
    { _id: bookingId },
    { $pull: { [`safetyReminders.${field}`]: userId } }
  ).catch(err => console.error('[MeetupSafety] release failed:', err.message));
}

async function notifyParticipant({ booking, recipientId, otherUser, reminderType, field, planLabel }) {
  const recipientIdStr = recipientId.toString();

  // The trusted-contact branch is decided HERE, server-side, because only the server
  // knows both participants and their contacts. Android is never asked to choose.
  let hasTrustedContact = false;
  if (reminderType === 'THIRTY_MINUTE') {
    hasTrustedContact = !!(await TrustedContact.exists({ userId: recipientId }));
  }

  const copy = buildCopy(reminderType, otherUser?.firstName, hasTrustedContact, planLabel);

  if (!(await claimReminder(booking._id, field, recipientId))) return false;

  const recipient = await User.findById(recipientId)
    .select('fcmTokens notificationPreferences')
    .lean();

  // Respect the user's own preference server-side as well as on the device. These are
  // safety REMINDERS, not emergencies, so they are muteable — they deliberately do not
  // use the SAFETY_ALERT/EMERGENCY bypass.
  if (recipient?.notificationPreferences?.safetyAlerts === false) {
    console.log(`[MeetupSafety] ${reminderType} suppressed by preference for ${recipientIdStr}`);
    return false;   // claim intentionally kept: do not retry a suppressed send
  }

  if (!recipient?.fcmTokens?.length) {
    // No device to reach. Release so a later tick can try once tokens exist, as long
    // as the reminder is still within its window.
    await releaseReminder(booking._id, field, recipientId);
    return false;
  }

  const result = await sendDataFcm(recipientIdStr, recipient.fcmTokens, {
    type:         'SURPRISE_ACTIVITY_SAFETY',
    reminderType,
    safetyAction: copy.safetyAction,
    // `bookingId` rather than a new `activityId` key: it is what every other Surprise
    // Activity payload already uses and what the Android handlers already read. One
    // name for one thing.
    bookingId:    booking._id.toString(),
    chatId:       booking.chatId ? booking.chatId.toString() : '',
    otherUserId:  otherUser?._id ? otherUser._id.toString() : '',
    otherUserName: otherUser?.firstName || '',
    recipientUserId: recipientIdStr,
    // REQUIRED for the published client: it does not know this type, so it falls through
    // to its generic handler, which renders data.title / data.body. Without these two it
    // would show "You have a new notification".
    title: copy.title,
    body:  copy.body,
    // Deliberately absent: coordinates, address, phone, email, profile data.
  });

  if (!result.delivered && result.attempted > 0 && result.successCount === 0 && result.error) {
    // A total send failure (Firebase down, auth, network) is worth retrying next tick.
    // A per-token rejection is not — fcmHelper already pruned those.
    await releaseReminder(booking._id, field, recipientId);
    return false;
  }

  console.log(`[MeetupSafety] ${reminderType} → ${recipientIdStr} booking=${booking._id}`);
  return true;
}

/**
 * One tick. Safe to run every minute, safe to run twice, safe to run on several
 * instances at once.
 */
async function tickMeetupSafetyReminders() {
  const now = new Date();

  const bookings = await RandomBooking.find({
    // COMPLETED is included because the feedback prompt fires after the activity has
    // been completed, not while it is still MATCHED.
    status:     { $in: ['MATCHED', 'COMPLETED'] },
    acceptorId: { $ne: null },
    startTime:  { $gte: new Date(now.getTime() - SCAN_BEHIND), $lte: new Date(now.getTime() + SCAN_AHEAD) },
  })
    .select('_id initiatorId acceptorId chatId startTime endTime status activityCategory safetyReminders')
    .lean();

  if (bookings.length === 0) return { scanned: 0, sent: 0, completed: 0 };

  let sent = 0;
  let completed = 0;

  for (const booking of bookings) {
    try {
      const startMs = new Date(booking.startTime).getTime();
      const endMs   = new Date(booking.endTime).getTime();
      const nowMs   = now.getTime();
      let status    = booking.status;

      // ── Completion ────────────────────────────────────────────────────────
      // Reuses the existing COMPLETED state and writes exactly the two fields the
      // existing POST /:bookingId/complete route writes. That route was never called
      // by anything, so matched activities stayed MATCHED forever and the lifecycle
      // never closed.
      //
      // COMPLETED here means what it has always meant for this route: the booked
      // window is over. It is not a claim that the meetup happened — neither was the
      // manual route — which is why the feedback prompt is optional and offers
      // "Maybe later".
      // `<=` not `<`: at exactly endTime the booked window is over. A strict compare
      // leaves a one-tick hole on the boundary.
      if (status === 'MATCHED' && endMs <= nowMs) {
        const done = await RandomBooking.findOneAndUpdate(
          { _id: booking._id, status: 'MATCHED' },
          { $set: { status: 'COMPLETED', completedAt: now } },
          { new: true, projection: { _id: 1 } }
        ).lean();
        if (done) { status = 'COMPLETED'; completed++; }
      }

      // Work out which reminder, if any, is due — and only one per booking per tick.
      let reminderType = null;
      let field        = null;

      if (status === 'MATCHED') {
        // Pre-meetup reminders only while the activity is still live and upcoming.
        if (nowMs >= startMs - TEN_MIN_BEFORE && nowMs < startMs + 5 * MIN) {
          reminderType = 'TEN_MINUTE';  field = 'tenMinute';
        } else if (nowMs >= startMs - THIRTY_MIN_BEFORE && nowMs < startMs - TEN_MIN_BEFORE) {
          // Closes when the 10-minute window opens, so a late tick sends the message
          // that is still true rather than one that is not.
          reminderType = 'THIRTY_MINUTE'; field = 'thirtyMinute';
        }
      } else if (status === 'COMPLETED') {
        if (nowMs >= endMs + FEEDBACK_DELAY && nowMs < endMs + FEEDBACK_WINDOW) {
          reminderType = 'POST_MEETUP_FEEDBACK'; field = 'feedback';
        }
      }

      if (!reminderType) continue;

      const already = new Set((booking.safetyReminders?.[field] || []).map(String));
      const participants = [booking.initiatorId, booking.acceptorId].filter(Boolean);
      const pending = participants.filter(p => !already.has(p.toString()));
      if (pending.length === 0) continue;

      const [initiator, acceptor] = await Promise.all([
        User.findById(booking.initiatorId).select('firstName').lean(),
        User.findById(booking.acceptorId).select('firstName').lean(),
      ]);
      const planLabel = CATEGORY_PLAN_LABEL[booking.activityCategory] || 'meetup';

      for (const recipientId of pending) {
        const isInitiator = recipientId.toString() === booking.initiatorId.toString();
        const otherUser   = isInitiator ? acceptor : initiator;
        // A deleted account leaves the other participant with nobody to be told about.
        if (!otherUser) continue;

        const ok = await notifyParticipant({
          booking, recipientId, otherUser, reminderType, field, planLabel,
        });
        if (ok) sent++;
      }
    } catch (err) {
      // One bad booking must never stop the tick for the others.
      console.error(`[MeetupSafety] booking ${booking._id} error:`, err.message);
    }
  }

  if (sent || completed) {
    console.log(`[MeetupSafety] scanned=${bookings.length} sent=${sent} completed=${completed}`);
  }
  return { scanned: bookings.length, sent, completed };
}

module.exports = { tickMeetupSafetyReminders, buildCopy };
