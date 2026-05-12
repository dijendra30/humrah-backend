// routes/profileAssistant.js
// ─────────────────────────────────────────────────────────────────────────────
// Profile Assistant — full Humrah app knowledge, strict data security.
//
// Endpoints:
//   POST /consent   → store profileBotConsent = true
//   POST /analyze   → button tap  → LOGIC ONLY (Groq only polishes wording)
//   POST /chat      → typed input → keyword intent → LOGIC, else Groq fallback
//   POST /ai-fix    → Groq generates + saves safe field values
//
// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY — DATA FIELDS THAT ARE NEVER SENT ANYWHERE:
//   ✗ email, password, googleId, facebookId
//   ✗ fcmTokens, pendingEmail, pendingEmailOTP, pendingEmailOTPExpires
//   ✗ last_known_lat, last_known_lng  (exact GPS coordinates)
//   ✗ verificationEmbedding           (face biometric data)
//   ✗ verificationPhoto, verificationPhotoPublicId
//   ✗ paymentInfo.upiId               (actual UPI ID string — PII)
//   ✗ paymentInfo.bankAccount
//   ✗ moderationFlags.violations[].originalValue
//   ✗ suspensionInfo, banInfo         (admin-sensitive)
//   ✗ safetyDisclaimerAcceptances, videoVerificationConsents
//   ✗ blockedUsers list
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { auth } = require('../middleware/auth');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const User    = require('../models/User');

// Per-endpoint rate limiter for assistant routes
// Prevents quota burn via rapid-fire requests
const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 20,              // 20 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (_req, res) => res.status(429).json({
    success: false,
    code: 'RATE_LIMITED',
    message: 'Slow down — you are sending requests too fast. Wait a moment and try again.',
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_MODEL       = 'llama-3.1-8b-instant';
const GROQ_DAILY_LIMIT = 5;

// ─── Groq usage tracking via User model (survives restarts) ──────────────────
// We store { date: 'YYYY-MM-DD', count: N } on user.groqUsage.
// Falls back to in-memory Map only if User.save() fails.
const getTodayStr = () => new Date().toISOString().slice(0, 10);

async function groqCallsToday(user) {
  const e = user.groqUsage;
  if (!e || e.date !== getTodayStr()) return 0;
  return e.count || 0;
}

async function incrementGroq(user) {
  const today = getTodayStr();
  const e     = user.groqUsage;
  user.groqUsage = (!e || e.date !== today)
    ? { date: today, count: 1 }
    : { date: today, count: (e.count || 0) + 1 };
  user.markModified('groqUsage');
  // fire-and-forget — don't block response on this write
  User.updateOne({ _id: user._id }, { groqUsage: user.groqUsage }).catch(() => {});
}

async function overGroqLimit(user) {
  return (await groqCallsToday(user)) >= GROQ_DAILY_LIMIT;
}

// ─────────────────────────────────────────────────────────────────────────────
// HUMRAH KNOWLEDGE BASE — static app knowledge used as Groq system prompt
// ─────────────────────────────────────────────────────────────────────────────

const HUMRAH_KNOWLEDGE_BASE = `
You are the Profile Assistant inside Humrah — an Indian social companion app for meeting
people for safe, public activities (coffee, movies, gaming, walks, food spots, etc.).
You know EVERYTHING about the app. Answer questions about profile, payments, bookings,
verification, settings, bugs, or safety in 3–5 lines. Be friendly, clear, and actionable.
Never make up features that don't exist. If unsure, suggest contacting support.

── PROFILE & COMPLETION ──────────────────────────────────────────────────────
Key profile fields: profile photo, bio (max 150 chars), age group, city/state/area,
hangout preferences, available times, meetup preference (1-on-1 or group),
vibe words, comfort activities, relax activities, music preference, budget comfort,
comfort zones, hangout frequency, goodMeetupMeaning, vibeQuote, interests, hobbies,
gender, language, personality type, mood, travel preference, pet preference,
fitness level, profession, education.
Completion score is based on 6 key fields: photo, bio, availability,
preferences (≥2), age group, city.
To edit: Profile → tap your photo/name → edit any field.
Edit rate limits: profile photo 1/day, bio 5/day, age group 1/month, state/area 2/month.

── ACTIVITY HOST / COMPANION MODE ────────────────────────────────────────────
userType: MEMBER or COMPANION.
To become a host: complete questionnaire → Activity Host Mode → "Yes, I'm interested".
Hosts set: activities offered (openFor), availability slots, cost-sharing (price), tagline (30 chars).
Host toggle: Profile → host-status toggle. OFF = hidden from discovery.
Host benefits: earn from bookings, appear in companion discovery, receive reviews.
To appear in discovery: host mode must be ON, profile must be complete, city must be set.

── PAYMENTS & EARNINGS ───────────────────────────────────────────────────────
Only COMPANION/Activity Hosts earn. Members do not earn.
UPI setup: Profile → Setup UPI → enter UPI ID (e.g. name@ybl, 9876543210@paytm).
Valid UPI handles: @paytm, @ybl, @oksbi, @okhdfcbank, @okaxis.
UPI statuses: not_set → pending_verification → verified (or failed).
UPI must be verified before payouts are processed.
Payout schedule:
  • Earnings ≥ ₹500: every Monday automatically.
  • Earnings < ₹500: 1st of every month.
If payment not received: check UPI is verified, check earnings dashboard,
confirm bookings are marked complete. Contact support if issue persists.

── VERIFICATION ─────────────────────────────────────────────────────────────
Statuses: not_submitted → pending → approved (or rejected or manual_review).
Video is processed by Face++: ≥70% match → APPROVED. 60–70% → MANUAL REVIEW. <60% → REJECTED.
If rejected: good lighting, face clearly visible, matches your profile photo.
Max 3 attempts per hour.
Verified badge appears on profile card and boosts bookings significantly.

── BOOKINGS & REVIEWS ────────────────────────────────────────────────────────
Members send activity requests to hosts. Hosts accept/reject.
After completion both parties can leave reviews (1–5 stars) within 7 days.
One review per booking — cannot be edited. Users can HIDE (not delete) reviews on their profile.
Report a fake review: tap ⋯ on the review → Report Review.

── GAMING SESSIONS ───────────────────────────────────────────────────────────
Create or join gaming sessions (game type, max players, start time).
States: waiting_for_players, full, starting, in_progress, completed, expired.
Chat stays open 3 hours after session start.
Anti-spam: 2-hour cooldown between creating sessions.

── MOVIE SESSIONS ────────────────────────────────────────────────────────────
Create movie session: pick a trending movie (TMDB) + nearby theatre (Google Places).
Others can join and chat. Session chat expires with the session.

── FOOD POSTS ────────────────────────────────────────────────────────────────
Share food discoveries: photo + caption (120 chars) + place + price range.
Posts expire after 48 hours. Feed shows posts within 15 km.

── SAFETY & MODERATION ──────────────────────────────────────────────────────
3 strikes → automatic suspension. Report user: flag icon on profile card.
Block user: ⋯ on profile → Block. Or Settings → Safety → Blocked Users.
Always meet in PUBLIC places. Tell someone where you are going.

── SETTINGS & ACCOUNT ────────────────────────────────────────────────────────
Change email: Settings → Account → Change Email (OTP to new email required).
Change password: Settings → Account → Change Password (min 8 chars, letter+number+special char).
Notifications: Settings → Notifications (toggle per category).
Delete account: Settings → scroll to bottom → Delete Account (permanent, cannot undo).

── SURPRISE ACTIVITY ─────────────────────────────────────────────────────────
Random activity booking with a companion matched by the system.
Available for MEMBER users who want to try an activity without planning.

── COMMON ISSUES ─────────────────────────────────────────────────────────────
"Profile not visible in discovery": host mode OFF, profile incomplete, city not set, or account restricted.
"Can't edit profile": rate limit hit (photo 1/day, bio 5/day, age group 1/month).
"Can't send message": account suspended or chat restriction active.
"Booking request not received": host mode OFF or profile incomplete.
"UPI verification stuck": re-enter UPI ID in Setup UPI, ensure it's active with your bank.
"Verification stuck in pending": usually resolves in 48h. Contact support if longer.
`;

// ─────────────────────────────────────────────────────────────────────────────
// SAFE PROFILE SUMMARY — no PII, no sensitive data
// ─────────────────────────────────────────────────────────────────────────────

function buildSafeProfileSummary(user) {
  const q = user.questionnaire || {};

  const hasProfilePhoto = !!user.profilePhoto;
  const bio             = (q.bio || '').trim();
  const preferences     = [
    ...(Array.isArray(q.hangoutPreferences) ? q.hangoutPreferences : []),
    ...(Array.isArray(q.interests)          ? q.interests          : []),
    ...(Array.isArray(q.comfortActivity)    ? q.comfortActivity    : []),
    ...(Array.isArray(q.hobbies)            ? q.hobbies            : []),
  ].filter(Boolean);
  const availability = Array.isArray(q.availableTimes) ? q.availableTimes : [];

  // Completion (6 key fields)
  const missingFields = [];
  if (!hasProfilePhoto)          missingFields.push('profilePhoto');
  if (bio.length < 10)           missingFields.push('bio');
  if (availability.length === 0) missingFields.push('availability');
  if (preferences.length < 2)   missingFields.push('preferences');
  if (!q.ageGroup)               missingFields.push('ageGroup');
  if (!q.city)                   missingFields.push('city');
  const completionScore = Math.round(((6 - missingFields.length) / 6) * 100);

  // Host
  const isHost     = user.userType === 'COMPANION' || q.becomeCompanion === "Yes, I'm interested";
  const hostActive = user.hostActive !== false;
  const hasTagline = !!(q.tagline && q.tagline.trim());
  const openFor    = Array.isArray(q.openFor) ? q.openFor : [];

  // Rich questionnaire context (for AI-fix, never sent as PII)
  const vibeWords        = Array.isArray(q.vibeWords)        ? q.vibeWords        : [];
  const lookingFor       = Array.isArray(q.lookingForOnHumrah)? q.lookingForOnHumrah : [];
  const comfortActivity  = Array.isArray(q.comfortActivity)  ? q.comfortActivity  : [];
  const relaxActivity    = Array.isArray(q.relaxActivity)    ? q.relaxActivity     : [];
  const musicPreference  = Array.isArray(q.musicPreference)  ? q.musicPreference  : [];
  const mood             = q.mood            || null;
  const personalityType  = q.personalityType || null;
  const ageGroup         = q.ageGroup        || null;
  const city             = q.city            || null;
  const meetupPreference = q.meetupPreference|| null;
  const budgetComfort    = q.budgetComfort   || null;
  const travelPreference = q.travelPreference|| null;
  const fitnessLevel     = q.fitnessLevel    || null;

  // Payment (status flags only — never UPI ID or bank details)
  const hasUpi           = !!(user.paymentInfo?.upiId);
  const upiStatus        = user.paymentInfo?.upiStatus        || 'not_set';
  const pendingPayout    = user.paymentInfo?.pendingPayout    || 0;
  const totalEarnings    = user.paymentInfo?.totalEarnings    || 0;
  const completedPayouts = user.paymentInfo?.completedPayouts || 0;

  // Verification
  const isVerified           = user.verified === true;
  const verificationStatus   = user.photoVerificationStatus  || 'not_submitted';
  const verificationType     = user.verificationType         || null;
  const verificationAttempts = user.verificationAttempts     || 0;
  const lastRejectionReason  = user.verificationRejections?.length > 0
    ? user.verificationRejections[user.verificationRejections.length - 1]?.reason || null
    : null;

  // Ratings
  const averageRating     = user.ratingStats?.averageRating     || 0;
  const totalRatings      = user.ratingStats?.totalRatings      || 0;
  const completedBookings = user.ratingStats?.completedBookings || 0;

  // Account
  const emailVerified       = user.emailVerified === true;
  const userType            = user.userType      || 'MEMBER';
  const accountStatus       = user.status        || 'ACTIVE';
  const daysSinceLastActive = user.lastActive
    ? Math.floor((Date.now() - new Date(user.lastActive).getTime()) / 86400000)
    : null;

  // Edit rate limits (bool only)
  const photoEditedToday = user.profileEditStats?.lastPhotoUpdate
    ? (Date.now() - new Date(user.profileEditStats.lastPhotoUpdate).getTime()) < 86400000
    : false;
  const canEditPhoto = !photoEditedToday;

  // Host-specific gaps
  const hostMissing = [];
  if (isHost) {
    if (!hasUpi)     hostMissing.push('upi');
    if (!isVerified) hostMissing.push('verification');
    if (!hasTagline) hostMissing.push('tagline');
    if (!hostActive) hostMissing.push('hostModeOff');
  }

  // Moderation — safe aggregate only
  const strikeCount     = user.moderationFlags?.strikeCount || 0;
  const isModerationFlagged = !!(user.moderationFlags?.isFlagged);

  return {
    hasProfilePhoto, bio, preferences, availability,
    completionScore, missingFields,
    isHost, hostActive, hasTagline, openFor, hostMissing,
    hasUpi, upiStatus, pendingPayout, totalEarnings, completedPayouts,
    isVerified, verificationStatus, verificationType, verificationAttempts, lastRejectionReason,
    averageRating, totalRatings, completedBookings,
    emailVerified, userType, accountStatus, daysSinceLastActive, canEditPhoto,
    strikeCount, isModerationFlagged,
    // Rich context (non-PII lifestyle fields — used for AI-fix context only)
    vibeWords, lookingFor, comfortActivity, relaxActivity, musicPreference,
    mood, personalityType, ageGroup, city, meetupPreference, budgetComfort,
    travelPreference, fitnessLevel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT MATCHER — keyword-based, covers a wide range of user phrasings
// ─────────────────────────────────────────────────────────────────────────────

function matchIntent(msg) {
  const l = msg.toLowerCase().trim();

  // Greetings / small talk
  if (/^(hi|hello|hey|hii|helo|sup|what's up|whats up|namaste|yo)\b/.test(l))
    return 'greeting';

  // Help / what can you do
  if (/\b(help|what can you do|what do you do|options|menu|assist|support)\b/.test(l) && l.length < 40)
    return 'help_menu';

  // Payment / earnings
  if (/\b(payment|upi|earn|payout|money|wallet|₹|rupee|not receiv|not paid|setup upi|settle|withdraw|pending amount|bank|salary|income from humrah|how.*earn|earning|paid)\b/.test(l))
    return 'payment_help';

  // Verification
  if (/\b(verif|badge|id proof|face|video verif|selfie|stuck.*verif|verif.*stuck|reject.*verif|verif.*reject|manual review|pending.*verif|attempt|trusted badge|blue tick|verify myself)\b/.test(l))
    return 'verification_help';

  // Host / companion mode
  if (/\b(host mode|become host|activ host|companion mode|host toggle|turn.*on.*host|host.*off|hosting|host.*profile|how.*become.*companion|companion.*how|start earning)\b/.test(l))
    return 'host_help';

  // Bookings
  if (/\b(booking|bookings|not getting|no booking|why.{0,25}book|more booking|get booking|request|activity request|no request|no one book)\b/.test(l))
    return 'booking_help';

  // Bio
  if (/\b(bio|write.*bio|better bio|bio.*help|help.*bio|about me|improve.*bio|bio.*tip|what.*write.*bio)\b/.test(l))
    return 'bio_help';

  // Priority / what to do first
  if (/\b(first|priority|most important|what.*improve|where.*start|start with|top.*issue|main.*issue|biggest.*issue)\b/.test(l))
    return 'first_improve';

  // Reviews / ratings
  if (/\b(rating|review|star|rated|feedback|hide review|report review|low rating|bad review|remove review)\b/.test(l))
    return 'review_help';

  // Edit limits
  if (/\b(edit.*limit|rate limit|can.{0,10}edit|edit.*block|photo.*limit|bio.*limit|too many edit|locked|can.{0,10}change photo|how many time.*edit)\b/.test(l))
    return 'edit_limit_help';

  // Profile completion
  if (/\b(complet|missing|fill|incomplete|finish|setup|set up|percent|%|score|how.*complete|profile.*done|done.*profile)\b/.test(l))
    return 'complete_profile';

  // General profile improvement
  if (/\b(improv|better|tips|help.*profile|profile.*help|enhance|update.*profile|suggestion|how.*look good|look better)\b/.test(l))
    return 'improve_profile';

  // Discovery / visibility
  if (/\b(not visible|not showing|hidden|discovery|not appear|search|show.*profile|profile.*not.*show|nobody.*find|can.{0,10}find me)\b/.test(l))
    return 'visibility_help';

  // Settings / account
  if (/\b(password|change.*email|email.*change|notif|notification|setting|account setting|change.*pass|delete account|account.*delete)\b/.test(l))
    return 'settings_help';

  // Bug / crash
  if (/\b(bug|crash|broken|not working|error|issue|problem|report bug|app.*crash|glitch|freezing|slow)\b/.test(l))
    return 'bug_help';

  // Safety / block / report
  if (/\b(block|report.*user|harass|unsafe|safety|suspend|ban|flag|inappropriate|report.*someone|feel unsafe|threatening)\b/.test(l))
    return 'safety_help';

  // Moderation / suspension
  if (/\b(suspend|banned|suspended|moderat|strike|warn|warning|account.*restrict|restrict.*account|flagged)\b/.test(l))
    return 'moderation_help';

  // Gaming
  if (/\b(gaming|game session|game.*room|play.*game|join.*game|create.*session|gaming.*humrah)\b/.test(l))
    return 'gaming_help';

  // Movie session
  if (/\b(movie.*session|watch.*together|movie.*humrah|movie.*room|join.*movie)\b/.test(l))
    return 'movie_help';

  // Food posts
  if (/\b(food post|food.*share|food.*photo|food.*discover|food.*humrah|post.*food)\b/.test(l))
    return 'food_help';

  // Delete account
  if (/\b(delete.*account|remove.*account|deactivate|close.*account)\b/.test(l))
    return 'delete_account_help';

  return null; // → Groq fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// FIELD TIPS
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_TIP = {
  profilePhoto: 'Add a clear, well-lit profile photo — profiles with photos get 3× more views.',
  bio:          'Write a short bio (at least 10 characters) so people know who you are.',
  availability: 'Set your available time slots so people know when you can meet.',
  preferences:  'Add at least 2 interests or hangout preferences to improve your matches.',
  ageGroup:     'Set your age group for better match suggestions.',
  city:         'Add your city so nearby people can discover you.',
};

const HOST_TIP = {
  upi:         'Set up your UPI ID (Profile → Setup UPI) — without it, you cannot receive any earnings.',
  verification:'Get verified — the verified badge is the biggest factor in increasing booking requests.',
  hostModeOff: 'Turn ON host mode in your profile — you are currently hidden from all discovery.',
  tagline:     'Add a tagline (30 chars) — it is the first text people see on your companion card.',
};

// ─────────────────────────────────────────────────────────────────────────────
// LOGIC ENGINE — deterministic, no AI needed
// ─────────────────────────────────────────────────────────────────────────────

function runLogicEngine(intent, s) {
  const {
    missingFields, completionScore, hasProfilePhoto, bio,
    preferences, availability, isHost, hasUpi, upiStatus,
    isVerified, verificationStatus, verificationType,
    verificationAttempts, lastRejectionReason,
    hostActive, hostMissing, hasTagline,
    pendingPayout, totalEarnings, completedPayouts,
    averageRating, totalRatings, completedBookings,
    emailVerified, userType, accountStatus, canEditPhoto,
    strikeCount, isModerationFlagged, daysSinceLastActive,
  } = s;

  switch (intent) {

    // ── Greeting ─────────────────────────────────────────────────────────────
    case 'greeting': {
      return {
        intro: 'Hey! 👋 I am your Humrah Profile Assistant.',
        bullets: [
          'I can help you improve your profile, fix issues, and understand app features.',
          'Try asking: "How do I get more bookings?" or "Help me set up payments" or just tap an option below.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Help menu ────────────────────────────────────────────────────────────
    case 'help_menu': {
      return {
        intro: 'Here is what I can help you with:',
        bullets: [
          '📋 Profile tips — improve bio, photo, preferences, availability.',
          '💰 Payments — UPI setup, payout schedule, earnings.',
          '✅ Verification — how to get verified and fix rejections.',
          '🏠 Host mode — become an Activity Host and get bookings.',
          '🛡️ Safety & settings — block users, change email/password, delete account.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Complete my profile ───────────────────────────────────────────────────
    case 'complete_profile': {
      if (missingFields.length === 0) {
        const extra = [];
        if (isHost && !hasUpi)     extra.push('Set up your UPI ID to start receiving earnings from bookings.');
        if (isHost && !isVerified) extra.push('Get verified — it significantly increases booking requests.');
        if (!emailVerified)        extra.push('Verify your email address for full account access.');
        return {
          intro: `Your profile is ${completionScore}% complete — all key fields are done! 🎉`,
          bullets: [
            'Refresh your bio every few weeks to stay relevant.',
            'Keep your availability updated to attract more connections.',
            ...extra,
          ].slice(0, 5),
          callToAction: null, completionScore, showOptionsAfter: true,
        };
      }
      return {
        intro: `Your profile is ${completionScore}% complete. Here is what is missing:`,
        bullets: missingFields.slice(0, 5).map(f => FIELD_TIP[f] || `Fill in your ${f}.`),
        callToAction: 'Fix Now', completionScore, showOptionsAfter: false,
      };
    }

    // ── Improve my profile ────────────────────────────────────────────────────
    case 'improve_profile': {
      const tips = [];
      tips.push(!hasProfilePhoto
        ? '📸 Add a real, well-lit photo — it is the first thing people notice and profiles with photos get 3× more views.'
        : '📸 Your photo is set. Make sure it is recent, shows your face clearly, and is taken in good lighting.');
      tips.push(bio.length < 10
        ? '✍️ Write a 2–3 sentence bio. Share what you enjoy and what kind of meetup you are open to.'
        : bio.length < 60
        ? `✍️ Your bio is a bit short (${bio.length} chars). Add a hobby or a favourite activity to make it pop.`
        : '✍️ Your bio is solid. Keep it authentic and refresh it occasionally.');
      tips.push(availability.length === 0
        ? '🕐 Set your availability so people know when you are free to meet.'
        : '🕐 Availability is set — update it whenever your schedule changes.');
      tips.push(preferences.length < 2
        ? '🎯 Add at least 2 interests to boost your discovery ranking and help people find common ground.'
        : preferences.length < 5
        ? `🎯 You have ${preferences.length} interests. A few more help people connect with you faster.`
        : '🎯 Great variety of interests — keep them current!');
      if (isHost && !hasUpi)     tips.push('💰 As a host, set up your UPI ID so you can receive earnings from completed bookings.');
      if (isHost && !isVerified) tips.push('✅ Get verified — the badge builds trust and directly increases booking requests.');
      if (!emailVerified)        tips.push('📧 Verify your email address for full account security.');
      return { intro: 'Here are personalised tips for your profile:', bullets: tips.slice(0, 5), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }

    // ── Why no bookings ───────────────────────────────────────────────────────
    case 'booking_help': {
      if (accountStatus !== 'ACTIVE') {
        return {
          intro: 'Your account is currently restricted.',
          bullets: [
            `Account status: ${accountStatus}. Bookings cannot be received while your account is restricted.`,
            'Contact support via Help & Support → Contact Support to resolve this.',
          ],
          callToAction: null, completionScore, showOptionsAfter: true,
        };
      }

      const reasons = [];
      if (!hasProfilePhoto)          reasons.push('No profile photo — the top reason people skip a profile.');
      if (bio.length < 10)           reasons.push('Missing or very short bio — people want to know who they are meeting.');
      if (availability.length === 0) reasons.push('No availability set — people cannot see when you are free.');
      if (preferences.length < 2)   reasons.push('Too few interests — add more so the matching system works better for you.');
      if (isHost && !hostActive)     reasons.push('Host mode is OFF — turn it ON in your profile to appear in companion discovery.');
      if (isHost && !isVerified)     reasons.push('Not verified — a verified badge significantly increases booking requests.');
      if (isHost && !hasUpi)         reasons.push('No UPI set up — required for paid bookings to process.');
      if (isHost && !hasTagline)     reasons.push('No host tagline — add one (30 chars) as it appears on your companion card.');
      if (!s.city)                   reasons.push('City not set — people nearby cannot discover you without it.');

      if (reasons.length === 0) {
        const activeTips = [
          'Log in daily — active profiles rank higher in discovery.',
          'Update your availability often so people know you are reachable.',
          'Refresh your bio every few weeks to feel current.',
        ];
        if (totalRatings === 0)     activeTips.push('No reviews yet — complete your first booking to start building your reputation.');
        else if (averageRating < 4) activeTips.push(`Your rating is ${averageRating}★ — focus on great experiences to push it above 4★.`);
        if (daysSinceLastActive > 7) activeTips.push(`You have been inactive for ${daysSinceLastActive} days — log in to boost your visibility.`);
        return { intro: 'Your profile looks great! 👍 Tips to attract more bookings:', bullets: activeTips.slice(0, 5), callToAction: null, completionScore, showOptionsAfter: true };
      }
      return { intro: `${reasons.length} thing${reasons.length > 1 ? 's are' : ' is'} holding back your bookings:`, bullets: reasons.slice(0, 5), callToAction: 'Fix Issues', completionScore, showOptionsAfter: false };
    }

    // ── Payment / UPI ─────────────────────────────────────────────────────────
    case 'payment_help': {
      if (!isHost) {
        return {
          intro: 'Earnings are only available for Activity Hosts.',
          bullets: [
            'MEMBER accounts do not earn from bookings.',
            'To become a host: Profile → Edit Profile → Activity Host Mode → "Yes, I\'m interested".',
            'Once you switch to COMPANION mode, set up your UPI ID to receive earnings.',
          ],
          callToAction: null, completionScore, showOptionsAfter: true,
        };
      }
      if (!hasUpi || upiStatus === 'not_set') {
        return {
          intro: 'You have not set up a UPI ID yet.',
          bullets: [
            'Go to: Profile → Setup UPI → enter your UPI ID.',
            'Valid formats: name@ybl, 9876543210@paytm, name@oksbi, name@okaxis.',
            'Your UPI must be verified before any payout is released.',
            'Your UPI name is matched against your profile name for fraud prevention.',
          ],
          callToAction: 'Setup UPI', completionScore, showOptionsAfter: false,
        };
      }
      if (upiStatus === 'pending_verification') {
        return {
          intro: 'Your UPI ID is saved but not yet verified.',
          bullets: [
            'Open Setup UPI → tap "Verify UPI" to complete verification.',
            'Payouts cannot be processed until your UPI is verified.',
          ],
          callToAction: 'Setup UPI', completionScore, showOptionsAfter: false,
        };
      }
      if (upiStatus === 'failed') {
        return {
          intro: 'Your UPI verification failed.',
          bullets: [
            'Go to Profile → Setup UPI and re-enter your UPI ID.',
            'Ensure the UPI ID is active and registered with your bank.',
            'Try: name@ybl, name@okaxis, number@paytm.',
          ],
          callToAction: 'Setup UPI', completionScore, showOptionsAfter: false,
        };
      }
      // Verified
      const nextPayout = pendingPayout >= 500
        ? `You will be paid automatically this Monday (earnings ≥ ₹500).`
        : `Earnings below ₹500 are paid on the 1st of next month (current pending: ₹${pendingPayout}).`;
      return {
        intro: 'Your UPI is verified ✅',
        bullets: [
          nextPayout,
          `Total earned: ₹${totalEarnings}. Payouts completed: ${completedPayouts}.`,
          'Full payout history: Profile → Earnings Dashboard → Payout History.',
          'If a scheduled payout is missing after the due date, contact support via Help & Support.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Verification ──────────────────────────────────────────────────────────
    case 'verification_help': {
      const tips = [];
      if (isVerified) {
        tips.push(`You are verified ✅ via ${verificationType || 'photo/video'} — your badge is visible on your profile card.`);
        tips.push('The verified badge boosts your discovery ranking and significantly increases booking requests.');
        tips.push('Keep your profile photo updated — it must match your verified face for ongoing trust.');
      } else if (verificationStatus === 'pending') {
        tips.push('Your verification is submitted and under review. Please wait up to 48 hours.');
        tips.push('You will receive a notification when the review is complete.');
        tips.push('Make sure your profile photo is a clear, well-lit photo of your face — it is used for the face match.');
      } else if (verificationStatus === 'rejected') {
        tips.push('Your verification was rejected.');
        if (lastRejectionReason) tips.push(`Reason given: ${lastRejectionReason}`);
        tips.push('To resubmit: Profile → tap the unverified badge → record a new verification video.');
        tips.push('Tips: good lighting, face clearly visible, no glasses, video matches your profile photo.');
        if (verificationAttempts >= 3) tips.push('You have made multiple attempts — wait at least 1 hour between submissions.');
      } else if (['manual_review', 'manual review'].includes(verificationStatus)) {
        tips.push('Your verification is in manual review by our safety team.');
        tips.push('Manual review can take up to 72 hours. You will be notified when it is complete.');
        tips.push('No action needed on your end — just wait for the notification.');
      } else {
        // not_submitted
        tips.push('You are not verified yet. A verified badge builds trust and increases bookings.');
        tips.push('To verify: Profile → tap the unverified badge → record a short video (4–10 seconds).');
        tips.push('The video is automatically compared to your profile photo using face-matching technology.');
        tips.push('Make sure your profile photo is a clear, recent, well-lit photo of your face before you start.');
      }
      return { intro: null, bullets: tips, callToAction: isVerified ? null : 'Get Verified', completionScore, showOptionsAfter: isVerified };
    }

    // ── Host mode ─────────────────────────────────────────────────────────────
    case 'host_help': {
      if (!isHost) {
        return {
          intro: 'You are not an Activity Host yet.',
          bullets: [
            'To become a host: Profile → Edit Profile → questionnaire → Activity Host Mode → "Yes, I\'m interested".',
            'As a host you set: activities you offer (openFor), your availability, cost-sharing preference, and a tagline.',
            'Set up your UPI ID so you can receive earnings from bookings.',
            'Get verified — the verified badge is the top factor in getting booking requests.',
            'Keep host mode ON to stay visible in companion discovery.',
          ],
          callToAction: 'Edit Profile', completionScore, showOptionsAfter: false,
        };
      }
      const hostTips = [];
      if (!hostActive)   hostTips.push('⚠️ Host mode is OFF — turn it ON in your profile to appear in companion discovery.');
      if (!isVerified)   hostTips.push('Get verified — it is the biggest factor in receiving bookings. Tap the unverified badge to start.');
      if (!hasUpi)       hostTips.push('Set up your UPI ID (Profile → Setup UPI) to receive your earnings.');
      if (!hasTagline)   hostTips.push('Add a host tagline (30 chars max) — it appears on your companion card and helps attract requests.');
      if (upiStatus === 'pending_verification') hostTips.push('Your UPI is saved but not verified — go to Setup UPI and tap Verify UPI to complete it.');

      if (hostTips.length === 0) {
        hostTips.push('Your host profile is fully set up! 🎉');
        hostTips.push('Respond to booking requests quickly — faster responses boost your discovery ranking.');
        hostTips.push('Keep your availability updated so the system can match you with nearby users.');
        if (totalRatings > 0) hostTips.push(`Your rating: ${averageRating}★ from ${totalRatings} review${totalRatings !== 1 ? 's' : ''} — keep delivering great experiences!`);
        else hostTips.push('You have no reviews yet — reviews directly boost your visibility. Focus on your first booking!');
      }
      return { intro: isHost ? 'Your Activity Host status:' : null, bullets: hostTips.slice(0, 5), callToAction: null, completionScore, showOptionsAfter: false };
    }

    // ── Bio help ──────────────────────────────────────────────────────────────
    case 'bio_help': {
      const tips = [];
      if (bio.length === 0) {
        tips.push('You have no bio yet — this is the second most important field after your photo.');
        tips.push('Start with who you are and what you enjoy. End with the kind of meetup you are open to.');
        tips.push('Example: "Coffee lover and weekend hiker. Open to chill conversations and exploring local food spots!"');
      } else if (bio.length < 30) {
        tips.push(`Your bio is very short (${bio.length} chars). Aim for 50–100 characters.`);
        tips.push('Mention 1–2 things you enjoy and what kind of meetup you are open to.');
      } else if (bio.length < 80) {
        tips.push('Your bio is decent but could be a bit more personal.');
        tips.push('Try adding a specific hobby, a favourite activity, or a place you love to visit.');
      } else {
        tips.push(`Great — your bio is ${bio.length} characters and solid! Keep it genuine.`);
        tips.push('Refresh it occasionally so it stays current and relevant.');
      }
      tips.push('Keep it under 150 characters. Do NOT include phone numbers, social handles, or links — they will be auto-removed.');
      tips.push('Bio can be edited up to 5 times per day.');
      return { intro: 'Bio tips:', bullets: tips.slice(0, 5), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }

    // ── What to do first ──────────────────────────────────────────────────────
    case 'first_improve': {
      const priority   = ['profilePhoto', 'bio', 'availability', 'preferences', 'ageGroup', 'city'];
      const topMissing = priority.filter(f => missingFields.includes(f));
      const hostPriority = isHost ? hostMissing : [];

      if (topMissing.length === 0 && hostPriority.length === 0) {
        return {
          intro: 'Your profile is complete! Stay active to rank higher:',
          bullets: [
            'Update your availability weekly.',
            'Refresh your bio monthly.',
            'Log in regularly to maintain your discovery ranking.',
          ],
          callToAction: null, completionScore, showOptionsAfter: true,
        };
      }

      const top     = topMissing[0];
      const hostTop = hostPriority[0];

      if (top) {
        return {
          intro: `Start here → ${top === 'profilePhoto' ? 'Add a profile photo' : top}`,
          bullets: [
            FIELD_TIP[top],
            topMissing[1] ? FIELD_TIP[topMissing[1]] : null,
            hostTop       ? HOST_TIP[hostTop]         : null,
          ].filter(Boolean),
          callToAction: 'Fix Now', completionScore, showOptionsAfter: false,
        };
      }
      return {
        intro: `Start here → ${hostTop}`,
        bullets: [HOST_TIP[hostTop], hostPriority[1] ? HOST_TIP[hostPriority[1]] : null].filter(Boolean),
        callToAction: hostTop === 'upi' ? 'Setup UPI' : 'Edit Profile', completionScore, showOptionsAfter: false,
      };
    }

    // ── Reviews / ratings ─────────────────────────────────────────────────────
    case 'review_help': {
      const bullets = [];
      if (totalRatings === 0) {
        bullets.push('You have no reviews yet — they appear after both parties in a completed booking submit feedback.');
        bullets.push('Review window: 7 days after a booking is marked complete and paid.');
      } else {
        bullets.push(`Your rating: ${averageRating}★ from ${totalRatings} review${totalRatings !== 1 ? 's' : ''} across ${completedBookings} completed booking${completedBookings !== 1 ? 's' : ''}.`);
        if (averageRating < 4) bullets.push('A rating below 4★ can lower your visibility. Focus on delivering great experiences.');
      }
      bullets.push('You can HIDE (not delete) a review on your profile — tap ⋯ on the review → Hide.');
      bullets.push('To report a fake or abusive review: tap ⋯ on the review → Report Review. Our team reviews it within 24h.');
      bullets.push('Reviews cannot be edited after submission. One review per booking.');
      return { intro: null, bullets, callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Edit limits ───────────────────────────────────────────────────────────
    case 'edit_limit_help': {
      return {
        intro: 'Profile edit limits:',
        bullets: [
          'Profile photo: 1 change per day.',
          'Bio: 5 changes per day.',
          'Age group: 1 change per month.',
          'State / area: 2 changes per month.',
          'Tagline: 5 changes per day.',
          'Daily limits reset at midnight. Monthly limits reset on the 1st of each month.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Visibility / discovery ────────────────────────────────────────────────
    case 'visibility_help': {
      const issues = [];
      if (!hasProfilePhoto)  issues.push('No profile photo — profiles without photos are ranked lower in discovery.');
      if (!s.city)           issues.push('City not set — location is required for you to appear in nearby searches.');
      if (isHost && !hostActive)   issues.push('Host mode is OFF — turn it ON in your profile to appear in companion discovery.');
      if (accountStatus !== 'ACTIVE') issues.push(`Your account status is "${accountStatus}" — restricted accounts are hidden from discovery.`);
      if (missingFields.length > 2)  issues.push(`Profile is only ${completionScore}% complete — complete profiles rank significantly higher.`);
      if (daysSinceLastActive > 14)  issues.push(`You have been inactive for ${daysSinceLastActive} days — log in regularly to stay visible.`);

      if (issues.length === 0) {
        return {
          intro: 'Your visibility settings look fine. Tips to improve ranking:',
          bullets: [
            'Log in daily — active profiles are ranked higher.',
            'Update your availability so you appear in "available now" filters.',
            'Get verified — verified profiles appear higher in search results.',
            'More interests and preferences = better matching = more visibility.',
          ],
          callToAction: null, completionScore, showOptionsAfter: true,
        };
      }
      return { intro: 'Reasons your profile may not be visible:', bullets: issues.slice(0, 5), callToAction: 'Fix Issues', completionScore, showOptionsAfter: false };
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    case 'settings_help': {
      return {
        intro: 'Common account settings:',
        bullets: [
          'Change email: Settings → Account → Change Email (OTP sent to new email, expires in 10 min).',
          'Change password: Settings → Account → Change Password (min 8 chars, must include letter, number, and special character).',
          'Notifications: Settings → Notifications — toggle activity requests, gaming alerts, community, and updates.',
          'Blocked users: Settings → Safety → Blocked Users (view or unblock).',
          'Delete account: Settings → scroll to bottom → Delete Account (permanent, cannot be undone).',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Bug ───────────────────────────────────────────────────────────────────
    case 'bug_help': {
      return {
        intro: 'Sorry something is not working!',
        bullets: [
          'Report it: Help & Support → Report a Bug.',
          'Select the issue type, describe what happened, and attach a screenshot if possible.',
          'Our team reviews all bug reports and fixes them in the next update.',
          'For urgent issues (account access, payment, suspension), use Help & Support → Contact Support.',
          'Try force-closing and reopening the app first — many glitches resolve on a fresh launch.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Safety ────────────────────────────────────────────────────────────────
    case 'safety_help': {
      return {
        intro: 'Staying safe on Humrah:',
        bullets: [
          'Always meet in PUBLIC places (cafes, malls, parks). Never accept invitations to private locations.',
          'Block someone: tap ⋯ on their profile → Block. Or go to Settings → Safety → Blocked Users.',
          'Report someone: tap the flag icon on their profile card → select a reason.',
          'If you feel unsafe during or after a meetup, leave immediately and report in the app.',
          '5 community reports on a user triggers an automatic safety review by our team.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Moderation / strikes / suspension ─────────────────────────────────────
    case 'moderation_help': {
      if (accountStatus === 'BANNED') {
        return {
          intro: 'Your account has been permanently banned.',
          bullets: [
            'Permanent bans are issued for severe or repeated community guideline violations.',
            'If you believe this is an error, contact support via Help & Support → Contact Support.',
          ],
          callToAction: null, completionScore, showOptionsAfter: false,
        };
      }
      if (accountStatus === 'SUSPENDED') {
        return {
          intro: 'Your account is currently suspended.',
          bullets: [
            'Suspension is a result of community guideline violations detected by our moderation system.',
            'Some suspensions are temporary — check your email for the suspension details and end date.',
            'Do not create a new account while suspended — it may result in a permanent ban.',
            'Contact support for clarification: Help & Support → Contact Support.',
          ],
          callToAction: null, completionScore, showOptionsAfter: false,
        };
      }
      const bullets = [];
      if (strikeCount > 0) {
        bullets.push(`You have ${strikeCount} moderation strike${strikeCount !== 1 ? 's' : ''} on your account.`);
        bullets.push('3 strikes lead to an automatic suspension. Strikes expire after 90 days of clean activity.');
      } else {
        bullets.push('Your account is in good standing with no active moderation strikes. ✅');
      }
      bullets.push('Common violations: sharing contact info in bio, inappropriate language, harassment, or discriminatory content.');
      bullets.push('Our system auto-cleans contact information (phone numbers, social handles) from your profile fields.');
      return { intro: null, bullets, callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Gaming sessions ───────────────────────────────────────────────────────
    case 'gaming_help': {
      return {
        intro: 'Gaming sessions on Humrah:',
        bullets: [
          'Create a session: Gaming tab → Create Session → pick game type, max players, and start time.',
          'Join a session: browse open sessions in the Gaming tab → tap Join.',
          'Session chat room stays open for 3 hours after the session start time.',
          'You can only create one session every 2 hours (anti-spam cooldown).',
          'Sessions automatically expire if they reach their start time without enough players.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Movie sessions ────────────────────────────────────────────────────────
    case 'movie_help': {
      return {
        intro: 'Movie sessions on Humrah:',
        bullets: [
          'Create a movie session: Movie tab → Create Session → pick a trending movie + a nearby theatre.',
          'Others in your area can join the session and chat.',
          'Session chat expires when the session ends.',
          'Great way to find someone to watch a new release with!',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Food posts ────────────────────────────────────────────────────────────
    case 'food_help': {
      return {
        intro: 'Food posts on Humrah:',
        bullets: [
          'Share food discoveries: Food tab → New Post → add a photo, caption (120 chars), place, and price range.',
          'Posts automatically expire after 48 hours.',
          'Your feed shows posts from people within 15 km of your location.',
          'Do not include phone numbers or social handles in captions — they will be auto-removed.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true,
      };
    }

    // ── Delete account ────────────────────────────────────────────────────────
    case 'delete_account_help': {
      return {
        intro: 'How to delete your account:',
        bullets: [
          'Go to: Settings → scroll to the very bottom → Delete Account.',
          '⚠️ This is PERMANENT and cannot be undone.',
          'All your data, bookings, reviews, and earnings history will be erased.',
          'If you have a pending payout, contact support BEFORE deleting your account.',
          'If you just want a break, consider logging out instead of deleting.',
        ],
        callToAction: null, completionScore, showOptionsAfter: false,
      };
    }

    // ── Fallback ──────────────────────────────────────────────────────────────
    default:
      return { intro: null, bullets: [], callToAction: null, completionScore, showOptionsAfter: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Polish bullets — ONE batch Groq call for all bullets (not 1 call per bullet)
async function polishBullets(bullets) {
  const key = process.env.GROQ_API_KEY;
  if (!key || bullets.length === 0) return bullets;

  const numbered = bullets.map((b, i) => `${i + 1}. ${b}`).join('\n');
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You help improve user profiles on Humrah, an Indian social companion app. Rewrite a numbered list of advice tips. Keep each tip warm, short, and actionable. One sentence max per tip. Keep emojis minimal. Return ONLY the same numbered list — no extra text.'
        },
        { role: 'user', content: `Rewrite these tips in a friendly, clear tone:\n${numbered}` },
      ],
      max_tokens: 400, temperature: 0.4,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 7000 });

    const raw = res.data?.choices?.[0]?.message?.content?.trim() || '';
    if (!raw) return bullets;

    // Parse numbered lines back into array
    const lines = raw.split('\n')
      .map(l => l.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean);

    // Safety: if Groq returned wrong count, fall back to originals
    if (lines.length !== bullets.length) return bullets;
    return lines.map((l, i) => (l.length > 0 && l.length < 250 ? l : bullets[i]));
  } catch {
    return bullets; // always fall back gracefully
  }
}

// Groq chat fallback — receives app knowledge + filtered non-PII profile data
async function groqFallback(userMessage, summary) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;

  const filteredData = [
    `Profile photo: ${summary.hasProfilePhoto ? 'yes' : 'no'}`,
    `Bio length: ${summary.bio.length} characters`,
    `Interests/preferences count: ${summary.preferences.length}`,
    `Availability slots: ${summary.availability.length}`,
    `Completion score: ${summary.completionScore}%`,
    `Missing fields: ${summary.missingFields.join(', ') || 'none'}`,
    `User type: ${summary.userType}`,
    `Is Activity Host: ${summary.isHost}`,
    `Host mode active: ${summary.hostActive}`,
    `UPI set up: ${summary.hasUpi} (status: ${summary.upiStatus})`,
    `Pending payout: ₹${summary.pendingPayout}`,
    `Verified: ${summary.isVerified} (status: ${summary.verificationStatus})`,
    `Verification attempts: ${summary.verificationAttempts}`,
    `Rating: ${summary.averageRating}★ from ${summary.totalRatings} reviews`,
    `Completed bookings: ${summary.completedBookings}`,
    `Email verified: ${summary.emailVerified}`,
    `Account status: ${summary.accountStatus}`,
    `Moderation strikes: ${summary.strikeCount}`,
    `Days since last active: ${summary.daysSinceLastActive ?? 'unknown'}`,
    `Mood: ${summary.mood || 'not set'}`,
    `Personality: ${summary.personalityType || 'not set'}`,
    `Age group: ${summary.ageGroup || 'not set'}`,
    `City: ${summary.city ? 'set' : 'not set'}`,
  ].join('\n');

  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: HUMRAH_KNOWLEDGE_BASE },
        { role: 'user',   content: `User's profile data (anonymised):\n${filteredData}\n\nUser's question: ${userMessage}\n\nAnswer in 3–5 lines. Be specific, friendly, and actionable based on their profile data above.` },
      ],
      max_tokens: 250, temperature: 0.55,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 9000 });
    return res.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[Assistant] Groq fallback error:', err?.response?.data || err.message);
    return null;
  }
}

// AI-fix — Groq generates field values from safe context and saves them
async function generateAndApplyAiFix(user, summary) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { success: false, message: 'AI fix requires GROQ_API_KEY on the server.' };

  const fixable = summary.missingFields.filter(f => ['bio', 'preferences', 'availability'].includes(f));
  if (fixable.length === 0) {
    return { success: true, message: 'Your profile data is already complete — no AI fixes needed!', applied: [] };
  }

  const q = user.questionnaire || {};

  // Non-PII context only
  const ctxLines = [
    Array.isArray(q.hangoutPreferences) && q.hangoutPreferences.length ? `Hangout style: ${q.hangoutPreferences.join(', ')}` : null,
    Array.isArray(q.interests)          && q.interests.length          ? `Interests: ${q.interests.join(', ')}`              : null,
    Array.isArray(q.vibeWords)          && q.vibeWords.length          ? `Vibe: ${q.vibeWords.join(', ')}`                   : null,
    Array.isArray(q.comfortActivity)    && q.comfortActivity.length    ? `Comfort activities: ${q.comfortActivity.join(', ')}`: null,
    Array.isArray(q.relaxActivity)      && q.relaxActivity.length      ? `Relax activities: ${q.relaxActivity.join(', ')}`    : null,
    Array.isArray(q.lookingForOnHumrah) && q.lookingForOnHumrah.length ? `Looking for: ${q.lookingForOnHumrah.join(', ')}`   : null,
    Array.isArray(q.hobbies)            && q.hobbies.length            ? `Hobbies: ${q.hobbies.join(', ')}`                  : null,
    Array.isArray(q.musicPreference)    && q.musicPreference.length    ? `Music: ${q.musicPreference.join(', ')}`             : null,
    q.mood             ? `Mood: ${q.mood}`                    : null,
    q.personalityType  ? `Personality: ${q.personalityType}`  : null,
    q.ageGroup         ? `Age group: ${q.ageGroup}`           : null,
    q.meetupPreference ? `Meetup pref: ${q.meetupPreference}` : null,
    q.budgetComfort    ? `Budget: ${q.budgetComfort}`          : null,
    q.travelPreference ? `Travel: ${q.travelPreference}`       : null,
    q.fitnessLevel     ? `Fitness: ${q.fitnessLevel}`          : null,
    q.gender           ? `Gender: ${q.gender}`                 : null,
  ].filter(Boolean).join('\n');

  const fieldInstructions = fixable.map(f => {
    if (f === 'bio')          return 'bio: a warm, genuine 2–3 sentence bio for a social companion app in India. Max 140 chars. No emojis. No phone numbers. No social handles. Make it specific to the user\'s context above.';
    if (f === 'preferences')  return 'interests: exactly 3 relevant interest strings as a JSON array. E.g. ["Gaming", "Coffee meetups", "Hiking"].';
    if (f === 'availability') return 'availableTimes: 2–3 realistic time slot strings as a JSON array. E.g. ["Weekday evenings", "Weekends", "Flexible"].';
    return null;
  }).filter(Boolean);

  const prompt = `You are filling in missing profile fields for a user on Humrah, an Indian social companion app.

Context about this user (non-personal):
${ctxLines || 'No additional context available — use generic friendly defaults.'}

Generate values ONLY for these missing fields:
${fieldInstructions.join('\n')}

Rules:
- Return ONLY a valid JSON object with keys: ${fixable.join(', ')}.
- No markdown, no explanation, no extra keys. Just raw JSON.
- Bio must be warm, genuine, under 140 characters, no emojis, no contact info.
- Make the bio specific to the context above — do not use generic templates.`;

  let generated;
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'Return only valid JSON. No markdown. No explanation. No extra keys.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 350, temperature: 0.65,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    const raw = res.data?.choices?.[0]?.message?.content?.trim() || '{}';
    generated = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    console.error('[Assistant] AI-fix generation error:', err?.response?.data || err.message);
    return { success: false, message: 'AI could not generate suggestions right now. Please try again in a moment.' };
  }

  if (!user.questionnaire) user.questionnaire = {};
  const applied = [];

  if (generated.bio && typeof generated.bio === 'string') {
    const bio = generated.bio.trim().slice(0, 140);
    if (bio.length >= 10 && !/https?:\/\//.test(bio) && !/\d{10}/.test(bio)) {
      user.questionnaire.bio = bio;
      applied.push({ field: 'bio', value: bio });
    }
  }

  if (Array.isArray(generated.interests) && generated.interests.length > 0) {
    const interests = generated.interests
      .filter(i => typeof i === 'string' && i.trim())
      .slice(0, 5)
      .map(i => i.trim());
    if (interests.length > 0) {
      const existing = Array.isArray(user.questionnaire.interests) ? user.questionnaire.interests : [];
      user.questionnaire.interests = [...new Set([...existing, ...interests])].slice(0, 8);
      applied.push({ field: 'interests', value: interests });
    }
  }

  if (Array.isArray(generated.availableTimes) && generated.availableTimes.length > 0) {
    const times = generated.availableTimes
      .filter(t => typeof t === 'string' && t.trim())
      .slice(0, 5)
      .map(t => t.trim());
    if (times.length > 0) {
      user.questionnaire.availableTimes = times;
      applied.push({ field: 'availability', value: times });
    }
  }

  if (applied.length === 0) {
    return { success: false, message: 'AI could not generate valid values. Please fill the fields manually from your profile.' };
  }

  user.markModified('questionnaire');
  await user.save();

  const newSummary = buildSafeProfileSummary(user);
  return {
    success: true,
    message: `AI updated ${applied.length} field${applied.length > 1 ? 's' : ''} on your profile! ✅`,
    applied,
    newCompletionScore: newSummary.completionScore,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/profile-assistant/consent
router.post('/consent', assistantLimiter, auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.profileBotConsent = true;
    await user.save();
    res.json({ success: true, message: 'Access granted.' });
  } catch (err) {
    console.error('[Assistant] consent:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/profile-assistant/analyze  (button tap → LOGIC ONLY)
router.post('/analyze', assistantLimiter, auth, async (req, res) => {
  try {
    const { intent } = req.body;
    const VALID_INTENTS = [
      'improve_profile', 'booking_help', 'complete_profile',
      'bio_help', 'first_improve', 'payment_help',
      'verification_help', 'host_help', 'settings_help',
      'bug_help', 'safety_help', 'review_help', 'edit_limit_help',
      'visibility_help', 'moderation_help', 'gaming_help',
      'movie_help', 'food_help', 'delete_account_help',
      'greeting', 'help_menu',
    ];

    if (!intent || !VALID_INTENTS.includes(intent)) {
      return res.status(400).json({
        success: false, code: 'INVALID_INTENT',
        message: "I didn't understand that. Please select one of the options.", showOptions: true,
      });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.profileBotConsent) {
      return res.status(403).json({
        success: false, code: 'CONSENT_REQUIRED',
        message: 'We need your permission to access your profile data to give personalised advice.',
      });
    }

    const summary = buildSafeProfileSummary(user);
    const result  = runLogicEngine(intent, summary);
    // Only polish if bullets are short enough to be worth it
    const bullets = result.bullets.length > 0 && process.env.GROQ_API_KEY
      ? await polishBullets(result.bullets)
      : result.bullets;

    return res.json({
      success: true, source: 'logic', intent,
      completionScore: result.completionScore,
      intro: result.intro,
      bullets,
      callToAction: result.callToAction,
      showOptionsAfter: result.showOptionsAfter,
    });

  } catch (err) {
    console.error('[Assistant] analyze:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/profile-assistant/chat  (typed input → intent → logic, else Groq)
router.post('/chat', assistantLimiter, auth, async (req, res) => {
  try {
    const { message, groqCallCount = 0 } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({
        success: false, code: 'EMPTY_MESSAGE',
        message: "I didn't catch that. Try asking something or use the quick options.", showOptions: true,
      });
    }

    const trimmed = message.trim();
    if (trimmed.length > 500) {
      return res.status(400).json({
        success: false, code: 'MESSAGE_TOO_LONG',
        message: 'Please keep your message under 500 characters.', showOptions: false,
      });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.profileBotConsent) {
      return res.status(403).json({
        success: false, code: 'CONSENT_REQUIRED',
        message: 'We need your permission to access your profile data to give personalised advice.',
      });
    }

    const summary = buildSafeProfileSummary(user);
    const matched = matchIntent(trimmed);

    if (matched) {
      const result  = runLogicEngine(matched, summary);
      const bullets = result.bullets.length > 0 && process.env.GROQ_API_KEY
        ? await polishBullets(result.bullets)
        : result.bullets;
      return res.json({
        success: true, source: 'logic', intent: matched,
        completionScore: result.completionScore,
        intro: result.intro,
        bullets,
        callToAction: result.callToAction,
        showOptionsAfter: result.showOptionsAfter || groqCallCount >= 2,
      });
    }

    // No intent matched → Groq fallback
    if (await overGroqLimit(user)) {
      return res.json({
        success: true, source: 'limit',
        intro: "You have reached today's AI assist limit.",
        bullets: ['Your daily AI limit resets at midnight.', 'Try one of the quick options below.'],
        callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore,
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.json({
        success: true, source: 'fallback',
        intro: "I didn't fully understand that. Try one of these options:",
        bullets: [], callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore,
      });
    }

    incrementGroq(user);
    let groqReply = null;
    try { groqReply = await groqFallback(trimmed, summary); } catch {}

    if (!groqReply) {
      return res.json({
        success: true, source: 'fallback',
        intro: "I didn't fully understand that. Try one of these options:",
        bullets: [], callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore,
      });
    }

    const newCount = groqCallCount + 1;
    return res.json({
      success: true, source: 'groq', groqReply,
      groqCallCount: newCount,
      showOptionsAfter: newCount >= 2,
      completionScore: summary.completionScore,
    });

  } catch (err) {
    console.error('[Assistant] chat:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/profile-assistant/ai-fix
router.post('/ai-fix', assistantLimiter, auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.profileBotConsent) {
      return res.status(403).json({
        success: false, code: 'CONSENT_REQUIRED',
        message: 'We need your permission to access your profile data.',
      });
    }

    const userId = req.userId.toString();
    if (await overGroqLimit(user)) {
      return res.status(429).json({
        success: false, code: 'DAILY_LIMIT',
        message: "You've reached today's AI assist limit. Try again tomorrow or fill the fields manually.",
      });
    }

    incrementGroq(user);
    const summary = buildSafeProfileSummary(user);
    const result  = await generateAndApplyAiFix(user, summary);

    return res.status(result.success ? 200 : 400).json(result);

  } catch (err) {
    console.error('[Assistant] ai-fix:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
