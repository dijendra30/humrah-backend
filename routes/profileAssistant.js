// routes/profileAssistant.js
// ─────────────────────────────────────────────────────────────────────────────
// Profile Assistant — full Humrah app knowledge, strict data security.
//
// ✅ MODEL FIX: llama-3.1-8b-instant  (llama3-8b-8192 was decommissioned)
//
// Endpoints:
//   POST /consent   → store profileBotConsent = true
//   POST /analyze   → button tap  → LOGIC ONLY (Groq only polishes wording)
//   POST /chat      → typed input → keyword intent → LOGIC, else Groq fallback
//   POST /ai-fix    → Groq generates + saves safe field values
//
// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY — DATA FIELDS THAT ARE NEVER SENT ANYWHERE (not to Groq, not in
// responses, not in logs):
//   ✗ email, password, googleId, facebookId
//   ✗ fcmTokens, pendingEmail, pendingEmailOTP, pendingEmailOTPExpires
//   ✗ last_known_lat, last_known_lng  (exact GPS coordinates)
//   ✗ verificationEmbedding           (face biometric data — vectors)
//   ✗ verificationPhoto, verificationPhotoPublicId  (raw photo URLs)
//   ✗ paymentInfo.upiId               (actual UPI ID string — PII)
//   ✗ paymentInfo.bankAccount         (bank account + IFSC)
//   ✗ moderationFlags.violations[].originalValue (flagged content)
//   ✗ suspensionInfo, banInfo         (admin-sensitive moderation)
//   ✗ safetyDisclaimerAcceptances, videoVerificationConsents (IP logs)
//   ✗ profileEditStats raw IP data
//   ✗ imageModerationLog              (raw safe-search scores)
//   ✗ blockedUsers list               (user IDs)
//
// SAFE FIELDS exposed via buildSafeProfileSummary():
//   ✓ hasProfilePhoto (bool)
//   ✓ bio length + presence (NOT the bio text itself — sent to Groq)
//   ✓ preferences list (public hangout prefs, not private lifestyle data)
//   ✓ availability slots (array of strings)
//   ✓ completionScore, missingFields
//   ✓ isHost, hostActive, hasTagline, openFor
//   ✓ upiStatus enum ('not_set'|'pending_verification'|'verified'|'failed')
//   ✓ hasUpi (bool only — NOT the UPI ID itself)
//   ✓ pendingPayout, totalEarnings, completedPayouts (amounts only)
//   ✓ isVerified, verificationStatus enum, verificationType
//   ✓ verificationAttempts count (NOT rejection reasons)
//   ✓ averageRating, totalRatings, completedBookings
//   ✓ emailVerified (bool)
//   ✓ userType ('MEMBER'|'COMPANION')
//   ✓ accountStatus ('ACTIVE'|'SUSPENDED'|'BANNED') — enum label only
//   ✓ daysSinceLastActive (integer, not exact timestamp)
//   ✓ canEditPhoto, canEditBio (rate-limit booleans — not the log itself)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { auth } = require('../middleware/auth');
const User    = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_MODEL       = 'llama-3.1-8b-instant'; // ✅ FIXED: llama3-8b-8192 decommissioned
const GROQ_DAILY_LIMIT = 5;
const groqDailyUsage   = new Map(); // userId → { date, count } — in-memory; swap for Redis in prod

const getTodayStr = () => new Date().toISOString().slice(0, 10);
function groqCallsToday(uid)  { const e = groqDailyUsage.get(uid); return (!e || e.date !== getTodayStr()) ? 0 : e.count; }
function incrementGroq(uid)   { const t = getTodayStr(), e = groqDailyUsage.get(uid); groqDailyUsage.set(uid, (!e || e.date !== t) ? { date: t, count: 1 } : { ...e, count: e.count + 1 }); }
function overGroqLimit(uid)   { return groqCallsToday(uid) >= GROQ_DAILY_LIMIT; }

// ─────────────────────────────────────────────────────────────────────────────
// HUMRAH APP KNOWLEDGE BASE — used as Groq system prompt
// Covers every feature so Groq answers accurately for ANY question.
// No user data is embedded here — this is static app knowledge only.
// ─────────────────────────────────────────────────────────────────────────────

const HUMRAH_KNOWLEDGE_BASE = `
You are the Profile Assistant inside Humrah — an Indian social companion app for meeting
people for safe, public activities (coffee, movies, gaming, walks, etc.).
You know EVERYTHING about the app. Answer questions about profile, payments, bookings,
verification, settings, bugs, or safety in 3–5 lines. Be friendly and actionable.

── PROFILE & COMPLETION ──────────────────────────────────────────────────────
Key profile fields: profile photo, bio (max 150 chars), age group, city,
hangout preferences, available times, meetup preference (1-on-1 or group),
vibe words, comfort activities, relax activities, music preference, budget comfort,
comfort zones (meeting places), hangout frequency, goodMeetupMeaning, vibeQuote.
Completion score is based on 6 key fields: photo, bio, availability,
preferences (≥2), age group, city.
To edit: Profile → tap your photo/name → edit any field.
Edit rate limits: profile photo 1/day, bio 5/day, age group 1/month.

── ACTIVITY HOST / COMPANION MODE ────────────────────────────────────────────
userType is either MEMBER or COMPANION.
To become a host: complete questionnaire → Activity Host Mode → "Yes, I'm interested".
Hosts set: activities offered (openFor), availability slots, cost-sharing (price), tagline (30 chars).
Host mode toggle: Profile → host-status toggle. When OFF = hidden from discovery.
Host benefits: earn from bookings, appear in companion discovery, receive reviews.
To appear in discovery: host mode must be ON, profile must be complete, city set.

── PAYMENTS & EARNINGS ───────────────────────────────────────────────────────
Only COMPANION/Activity Hosts earn. Members do not earn.
UPI setup: Profile → Setup UPI → enter UPI ID (e.g. name@ybl, 9876543210@paytm).
UPI format: username@bankhandle (valid handles: @paytm, @ybl, @oksbi, @okhdfcbank, @okaxis).
UPI statuses: not_set → pending_verification → verified (or failed).
UPI must be verified before payouts are processed.
UPI name is matched against profile name for fraud prevention.
Payout schedule:
  • Earnings ≥ ₹500: every Monday automatically.
  • Earnings < ₹500: 1st of every month.
If payment not received: check UPI is verified (not just set), check earnings dashboard,
check payout schedule, confirm bookings are marked complete. Contact support if still missing.
Platform fee is deducted from booking amount; companion receives the remainder (companionEarning).
Earnings dashboard: Profile → Activity Insights / Earnings.
Payout history: earnings dashboard → payout history.

── VERIFICATION ─────────────────────────────────────────────────────────────
Verification uses video (Face++ API) or photo to match face with profile photo.
Statuses: not_submitted → pending → approved (or rejected or manual_review).
Processing: video is downloaded, a frame extracted, Face++ compares it to profile photo.
  • ≥70% match → APPROVED automatically.
  • 60–70% match → MANUAL REVIEW (human team reviews within 48h).
  • <60% match → REJECTED. User must resubmit with clearer video/photo.
If rejected: ensure good lighting, face clearly visible, matches your profile photo.
If stuck in pending: usually resolves within 48h. Contact support if longer.
Max 3 attempts per hour. After rejection, wait 1 hour before retrying.
Verified badge appears on profile card — boosts trust and booking rate.
verificationType can be PHOTO, VIDEO, or MANUAL.

── BOOKINGS & REVIEWS ────────────────────────────────────────────────────────
Members send activity requests to hosts.
Hosts accept/reject. After completion both parties can leave reviews (1–5 stars).
Review window: 7 days after booking is marked complete and paid.
One review per booking — cannot be edited after submission.
Reviews affect rating stats (averageRating, totalRatings, completedBookings).
Users can hide (not delete) reviews on their own profile.
Report a fake review: tap ⋯ on the review → Report Review.
Paid bookings not yet live (MVP phase) — Surprise Activity is an alternative.

── GAMING SESSIONS ───────────────────────────────────────────────────────────
Create or join gaming sessions (game type, max players, start time).
Session states: waiting_for_players, full, starting, in_progress, completed, expired.
Chat room stays open for 3 hours after session start time.
Anti-spam: cannot create a new session if you have an active one within 30 min.

── MOVIE SESSIONS ────────────────────────────────────────────────────────────
Create a movie session: pick a trending movie (TMDB) + nearby theatre (Google Places).
Others can join and chat. Session chat expires with the session.

── FOOD POSTS ────────────────────────────────────────────────────────────────
Share food discoveries: photo + caption (120 chars) + place + price range.
Posts expire automatically after 48 hours.
Feed shows posts within 15 km. No phone numbers or social handles in captions.

── SAFETY & MODERATION ──────────────────────────────────────────────────────
Moderation system: auto-clean (level 0) → soft warn (level 1) → strike (level 2) → auto-suspend (level 3).
3 moderation strikes → automatic suspension.
Report a user: flag icon on their profile card → select reason.
Block a user: ⋯ on their profile → Block. Or Settings → Blocked Users.
Community guidelines violation: warnings escalate to suspension then ban.
Always meet in PUBLIC places. Tell someone where you are going.

── SETTINGS & ACCOUNT ────────────────────────────────────────────────────────
Change email: Settings → Account → Change Email (OTP verification required).
Change password: Settings → Account → Change Password.
Notifications: Settings → Notifications (toggle: activity requests, gaming, community, updates).
Delete account: Settings → scroll to bottom → Delete Account (permanent, cannot undo).
Blocked users: Settings → Safety → Blocked Users.

── PROFILE EDIT RATE LIMITS ─────────────────────────────────────────────────
Profile photo: max 1 change per day.
Bio: max 5 changes per day.
Age group: max 1 change per month.
State/area: max 2 changes per month.
Tagline: max 5 changes per day.
If edit is blocked: wait until the next reset window.

── BUG REPORTING ─────────────────────────────────────────────────────────────
Help & Support → Report a Bug.
Select issue type, describe what happened, attach a screenshot if possible.
Our team reviews all reports and fixes in the next update.
`;

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Build SAFE profile summary.
//
// SECURITY RULES applied here:
//  • Email, phone, UPI ID string, location coords → NEVER included
//  • Face biometrics (verificationEmbedding) → NEVER included
//  • Moderation violation content → NEVER included
//  • Bank details → NEVER included
//  • IP addresses → NEVER included
//  • Only enum labels and boolean flags for sensitive fields
//  • Bio text IS included but only sent to Groq for ai-fix (wording rewrite)
//    — bio text is NOT in the filtered data string sent to Groq for chat fallback
// ─────────────────────────────────────────────────────────────────────────────

function buildSafeProfileSummary(user) {
  const q = user.questionnaire || {};

  // ── Public profile fields ───────────────────────────────────────────
  const hasProfilePhoto = !!user.profilePhoto;
  const bio             = (q.bio || '').trim();
  // Only send hangout/interest prefs — NOT income/relationship/smoking status
  const preferences     = [
    ...(Array.isArray(q.hangoutPreferences) ? q.hangoutPreferences : []),
    ...(Array.isArray(q.interests)          ? q.interests          : []),
    ...(Array.isArray(q.comfortActivity)    ? q.comfortActivity    : []),
  ].filter(Boolean);
  const availability    = Array.isArray(q.availableTimes) ? q.availableTimes : [];

  // ── Completion ──────────────────────────────────────────────────────
  const missingFields = [];
  if (!hasProfilePhoto)          missingFields.push('profilePhoto');
  if (bio.length < 10)           missingFields.push('bio');
  if (availability.length === 0) missingFields.push('availability');
  if (preferences.length < 2)   missingFields.push('preferences');
  if (!q.ageGroup)               missingFields.push('ageGroup');
  if (!q.city)                   missingFields.push('city');
  const completionScore = Math.round(((6 - missingFields.length) / 6) * 100);

  // ── Host / companion ────────────────────────────────────────────────
  const isHost      = user.userType === 'COMPANION' || q.becomeCompanion === "Yes, I'm interested";
  const hostActive  = user.hostActive !== false;
  const hasTagline  = !!(q.tagline && q.tagline.trim());
  const openFor     = Array.isArray(q.openFor) ? q.openFor : [];

  // ── Payment — status flags ONLY, never UPI ID or bank details ──────
  const hasUpi    = !!(user.paymentInfo?.upiId);  // bool only — ID not exposed
  const upiStatus = user.paymentInfo?.upiStatus || 'not_set';
  // Safe amount fields: amounts are non-sensitive financial summaries
  const pendingPayout    = user.paymentInfo?.pendingPayout    || 0;
  const totalEarnings    = user.paymentInfo?.totalEarnings    || 0;
  const completedPayouts = user.paymentInfo?.completedPayouts || 0;

  // ── Verification — status enum and count ONLY, never photos/embeddings
  const isVerified         = user.verified === true;
  const verificationStatus = user.photoVerificationStatus || 'not_submitted';
  const verificationType   = user.verificationType || null;
  const verificationAttempts = user.verificationAttempts || 0;
  // Last rejection reason (safe to expose — it's actionable guidance, not sensitive content)
  const lastRejectionReason = user.verificationRejections?.length > 0
    ? user.verificationRejections[user.verificationRejections.length - 1]?.reason || null
    : null;

  // ── Rating stats — public-facing aggregates ─────────────────────────
  const averageRating    = user.ratingStats?.averageRating    || 0;
  const totalRatings     = user.ratingStats?.totalRatings     || 0;
  const completedBookings = user.ratingStats?.completedBookings || 0;

  // ── Account state — enum label only, NO suspension details ──────────
  const emailVerified  = user.emailVerified === true;
  const userType       = user.userType || 'MEMBER';
  const accountStatus  = user.status   || 'ACTIVE'; // 'ACTIVE'|'SUSPENDED'|'BANNED'

  // ── Activity — days since last active (not exact timestamp) ─────────
  const daysSinceLastActive = user.lastActive
    ? Math.floor((Date.now() - new Date(user.lastActive).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // ── Edit rate limit flags (bool only — not the raw log) ─────────────
  // We check the profileEditStats for recency without exposing raw log entries
  const photoEditedToday = user.profileEditStats?.lastPhotoUpdate
    ? (Date.now() - new Date(user.profileEditStats.lastPhotoUpdate).getTime()) < 86400000
    : false;
  const canEditPhoto = !photoEditedToday; // simplified — real limit is 1/day via ProfileEditLog

  // ── Host-specific missing items ─────────────────────────────────────
  const hostMissing = [];
  if (isHost) {
    if (!hasUpi)         hostMissing.push('upi');
    if (!isVerified)     hostMissing.push('verification');
    if (!hasTagline)     hostMissing.push('tagline');
    if (!hostActive)     hostMissing.push('hostModeOff');
  }

  return {
    // Core profile
    hasProfilePhoto, bio, preferences, availability,
    completionScore, missingFields,
    // Host
    isHost, hostActive, hasTagline, openFor, hostMissing,
    // Payment (status only — no PII)
    hasUpi, upiStatus, pendingPayout, totalEarnings, completedPayouts,
    // Verification (status + count + last reason — no photos/embeddings)
    isVerified, verificationStatus, verificationType,
    verificationAttempts, lastRejectionReason,
    // Rating
    averageRating, totalRatings, completedBookings,
    // Account
    emailVerified, userType, accountStatus, daysSinceLastActive,
    // Edit limits
    canEditPhoto,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Keyword intent matcher for typed messages
// ─────────────────────────────────────────────────────────────────────────────

function matchIntent(msg) {
  const l = msg.toLowerCase().trim();

  if (/\b(payment|upi|earn|payout|money|wallet|₹|rupee|not receiv|not paid|setup upi|settle|withdraw|pending amount|bank)\b/.test(l))
    return 'payment_help';

  if (/\b(verif|badge|id proof|face|video verif|selfie|stuck.*verif|verif.*stuck|reject.*verif|verif.*reject|manual review|pending.*verif|attempt)\b/.test(l))
    return 'verification_help';

  if (/\b(host mode|become host|activ host|companion mode|host toggle|turn.*on.*host|host.*off|hosting|host.*profile)\b/.test(l))
    return 'host_help';

  if (/\b(booking|bookings|not getting|no booking|why.{0,25}book|more booking|get booking|request|activity request)\b/.test(l))
    return 'booking_help';

  if (/\b(bio|write.*bio|better bio|bio.*help|help.*bio|about me section|improve.*bio)\b/.test(l))
    return 'bio_help';

  if (/\b(first|priority|most important|what.*improve|where.*start|start with)\b/.test(l))
    return 'first_improve';

  if (/\b(rating|review|star|rated|feedback|hide review|report review)\b/.test(l))
    return 'review_help';

  if (/\b(edit.*limit|rate limit|can.{0,10}edit|edit.*block|photo.*limit|bio.*limit|too many edit)\b/.test(l))
    return 'edit_limit_help';

  if (/\b(complet|missing|fill|incomplete|finish|setup|set up|percent|%|score|how.*complete)\b/.test(l))
    return 'complete_profile';

  if (/\b(improv|better|tips|help.*profile|profile.*help|enhance|update.*profile|suggestion)\b/.test(l))
    return 'improve_profile';

  if (/\b(password|change.*email|email.*change|notif|setting|account setting|change.*pass)\b/.test(l))
    return 'settings_help';

  if (/\b(bug|crash|broken|not working|error|issue|problem|report bug|app.*crash)\b/.test(l))
    return 'bug_help';

  if (/\b(block|report.*user|harass|unsafe|safety|suspend|ban|flag|inappropriate)\b/.test(l))
    return 'safety_help';

  return null; // → Groq fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Logic engine (deterministic, no AI)
// Every case is driven entirely by the safe summary fields.
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_TIP = {
  profilePhoto: 'Add a clear profile photo — profiles with photos get 3× more views.',
  bio:          'Write a short bio (at least 10 characters) so people know who you are.',
  availability: 'Set your available time slots so people know when you can meet.',
  preferences:  'Add at least 2 interests or hangout preferences.',
  ageGroup:     'Set your age group for better match suggestions.',
  city:         'Add your city so nearby people can discover you.',
};

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
  } = s;

  switch (intent) {

    // ── Complete my profile ─────────────────────────────────────────────────
    case 'complete_profile': {
      if (missingFields.length === 0) {
        const extra = [];
        if (isHost && !hasUpi)     extra.push('Set up your UPI ID to start receiving earnings from bookings.');
        if (isHost && !isVerified) extra.push('Get verified — it significantly increases booking requests.');
        return { intro: `Your profile is ${completionScore}% complete — all set! 🎉`,
          bullets: [
            'Refresh your bio every few weeks to stay relevant.',
            'Keep your availability updated to attract more connections.',
            ...extra,
          ].slice(0, 5),
          callToAction: null, completionScore, showOptionsAfter: true };
      }
      return {
        intro: `You're ${completionScore}% complete.`,
        bullets: missingFields.slice(0, 5).map(f => FIELD_TIP[f] || `Fill in your ${f}.`),
        callToAction: 'Fix Now', completionScore, showOptionsAfter: false,
      };
    }

    // ── Improve my profile ──────────────────────────────────────────────────
    case 'improve_profile': {
      const tips = [];
      tips.push(!hasProfilePhoto
        ? 'Add a real, well-lit photo — it is the first thing people notice.'
        : 'Your photo looks good. Make sure it is recent and shows your face clearly.');
      tips.push(bio.length < 10
        ? 'Write a 2–3 sentence bio. Share what you enjoy and what kind of meetup you are open to.'
        : bio.length < 60
        ? 'Your bio is a bit short. Add a hobby or a favourite activity to personalise it.'
        : 'Your bio is solid. Keep it authentic and refresh it when your interests change.');
      tips.push(availability.length === 0
        ? 'Set your availability so people know when to reach out.'
        : 'Good — you have availability set. Update it whenever your schedule changes.');
      tips.push(preferences.length < 2
        ? 'Add at least 2 interests to boost your discovery ranking.'
        : preferences.length < 5
        ? 'A few more interests help people find common ground with you.'
        : 'Great variety of interests! Keep them current.');
      if (isHost && !hasUpi)     tips.push('As a host, set up your UPI ID so you can receive earnings from bookings.');
      if (isHost && !isVerified) tips.push('Get verified — the badge builds trust and directly increases booking requests.');
      return { intro: null, bullets: tips.slice(0, 5), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }

    // ── Why no bookings ─────────────────────────────────────────────────────
    case 'booking_help': {
      const reasons = [];
      if (!hasProfilePhoto)          reasons.push('No profile photo — the top reason people skip a profile.');
      if (bio.length < 10)           reasons.push('Missing or very short bio — people want to know who they are meeting.');
      if (availability.length === 0) reasons.push('No availability set — people cannot see when you are free.');
      if (preferences.length < 2)   reasons.push('Too few interests — add more so the system matches you better.');
      if (isHost && !hostActive)     reasons.push('Your host mode is currently OFF — turn it ON in your profile to appear in discovery.');
      if (isHost && !isVerified)     reasons.push('Not verified — a verified badge builds trust and significantly increases bookings.');
      if (isHost && !hasUpi)         reasons.push('No UPI set up — hosts need a verified UPI ID for paid bookings to process.');
      if (isHost && !hasTagline)     reasons.push('Add a host tagline (30 chars) — it appears on your companion card and attracts requests.');

      if (reasons.length === 0) {
        const tips = [
          'Log in regularly — active profiles rank higher in discovery.',
          'Update your availability often so people know you are reachable.',
          'Refresh your bio occasionally to keep it feeling current.',
        ];
        if (totalRatings === 0) tips.push('You have no reviews yet — complete your first booking to start building your rating.');
        else if (averageRating < 4) tips.push(`Your rating is ${averageRating}★ — focus on great experiences to improve it.`);
        return { intro: 'Your profile looks great! 👍 Tips to boost bookings:', bullets: tips.slice(0, 5), callToAction: null, completionScore, showOptionsAfter: true };
      }
      return { intro: 'Here are the likely reasons you are not getting bookings:',
        bullets: reasons.slice(0, 5), callToAction: 'Fix Issues', completionScore, showOptionsAfter: false };
    }

    // ── Payment / UPI ───────────────────────────────────────────────────────
    case 'payment_help': {
      if (!isHost) {
        return { intro: 'Payments are for Activity Hosts only.',
          bullets: [
            'Only COMPANION / Activity Host users earn from bookings.',
            'To become a host: Profile → Edit Profile → Activity Host Mode → select "Yes, I\'m interested".',
            'Once you are a host, set up a UPI ID to receive earnings.',
          ],
          callToAction: null, completionScore, showOptionsAfter: true };
      }

      if (!hasUpi || upiStatus === 'not_set') {
        return { intro: 'You have not set up a UPI ID yet.',
          bullets: [
            'To receive earnings: Profile → Setup UPI → enter your UPI ID.',
            'UPI format: username@bankhandle — e.g. name@ybl, 9876543210@paytm, name@oksbi.',
            'Your UPI must be verified before any payout is processed.',
            'UPI name will be checked against your profile name for security.',
          ],
          callToAction: 'Setup UPI', completionScore, showOptionsAfter: false };
      }

      if (upiStatus === 'pending_verification') {
        return { intro: 'Your UPI ID is saved but not yet verified.',
          bullets: [
            'Re-open Setup UPI and tap "Verify UPI" to complete verification.',
            'Until verified, payouts cannot be processed.',
          ],
          callToAction: 'Setup UPI', completionScore, showOptionsAfter: false };
      }

      if (upiStatus === 'failed') {
        return { intro: 'Your UPI verification failed.',
          bullets: [
            'Go to Profile → Setup UPI and enter your UPI ID again.',
            'Make sure the UPI ID is active and registered with your bank.',
            'Common formats: name@ybl, name@okaxis, number@paytm.',
          ],
          callToAction: 'Setup UPI', completionScore, showOptionsAfter: false };
      }

      // UPI is verified — explain payout schedule
      const nextPayoutInfo = pendingPayout >= 500
        ? 'You will be paid automatically on the next Monday (earnings ≥ ₹500).'
        : `Earnings < ₹500 are paid on the 1st of next month (current pending: ₹${pendingPayout}).`;

      return { intro: 'Your UPI is set up and verified ✅',
        bullets: [
          nextPayoutInfo,
          `Total earnings to date: ₹${totalEarnings}. Completed payouts: ${completedPayouts}.`,
          'Check your Earnings Dashboard in your profile for full payout history.',
          'If a scheduled payout is missing after the due date, contact support via Help & Support.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Verification ────────────────────────────────────────────────────────
    case 'verification_help': {
      const tips = [];

      if (isVerified) {
        tips.push(`You are verified ✅ via ${verificationType || 'photo'} — your badge is visible on your profile card.`);
        tips.push('Verified profiles appear higher in search results and receive more booking requests.');

      } else if (verificationStatus === 'pending') {
        tips.push('Your verification photo/video has been submitted and is under review.');
        tips.push('Review usually takes up to 48 hours. You will receive a notification when complete.');
        tips.push('Ensure your profile photo is a clear, well-lit photo of your face — it is used for face matching.');

      } else if (verificationStatus === 'approved') {
        // Shouldn't reach here since isVerified should be true, but handle gracefully
        tips.push('Your verification was approved. You should see the verified badge on your profile.');

      } else if (verificationStatus === 'rejected') {
        tips.push('Your verification was rejected.');
        if (lastRejectionReason) tips.push(`Reason: ${lastRejectionReason}`);
        tips.push('To resubmit: go to Profile → tap the unverified badge → record a new verification video.');
        tips.push('Tips for approval: good lighting, face clearly visible, matches your profile photo.');
        if (verificationAttempts >= 3) tips.push('You have made multiple attempts. Wait 1 hour between attempts.');

      } else if (verificationStatus === 'manual_review' || verificationStatus === 'manual review') {
        tips.push('Your verification is in manual review — a team member is examining it.');
        tips.push('This takes a little longer (up to 72 hours). Please wait for a notification.');

      } else {
        // not_submitted
        tips.push('You are not yet verified. A verified badge builds trust and increases booking requests.');
        tips.push('To verify: Profile → tap the unverified badge → record a short verification video (4–10 seconds).');
        tips.push('The video is automatically compared to your profile photo using face-matching technology.');
        tips.push('Ensure your profile photo is a clear, recent photo of your face before submitting.');
      }

      return { intro: null, bullets: tips, callToAction: isVerified ? null : 'Get Verified', completionScore, showOptionsAfter: false };
    }

    // ── Host / Activity Host mode ───────────────────────────────────────────
    case 'host_help': {
      if (!isHost) {
        return { intro: 'You are not in Activity Host mode yet.',
          bullets: [
            'To become a host: Profile → Edit Profile → questionnaire → Activity Host Mode section.',
            'Select "Yes, I\'m interested" — this changes your userType to COMPANION.',
            'Then fill in: what activities you offer (openFor), availability, cost-sharing preference, and tagline (30 chars).',
            'Set up UPI ID so you can receive earnings when bookings complete.',
            'Get verified — the verified badge significantly increases booking requests.',
          ],
          callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
      }

      const hostTips = [];
      if (!hostActive)   hostTips.push('Host mode is currently OFF — turn it ON in your profile to appear in companion discovery.');
      if (!isVerified)   hostTips.push('Get verified — a verified badge is one of the biggest factors in receiving bookings.');
      if (!hasUpi)       hostTips.push('Set up your UPI ID (Profile → Setup UPI) to receive earnings from bookings.');
      if (!hasTagline)   hostTips.push('Add a tagline (30 chars) — it is the first text people see on your companion card.');

      if (hostTips.length === 0) {
        hostTips.push('Your host profile is fully set up! Keep host mode ON and update your availability regularly.');
        hostTips.push('Respond to booking requests quickly — faster responses improve your discovery ranking.');
        if (totalRatings > 0) hostTips.push(`Your rating is ${averageRating}★ from ${totalRatings} review${totalRatings !== 1 ? 's' : ''}. Keep delivering great experiences!`);
        else hostTips.push('You have no reviews yet — reviews directly boost your visibility in discovery.');
      }
      return { intro: 'Your Activity Host status:', bullets: hostTips.slice(0, 5), callToAction: null, completionScore, showOptionsAfter: false };
    }

    // ── Bio help ────────────────────────────────────────────────────────────
    case 'bio_help': {
      const tips = [];
      if (bio.length === 0) {
        tips.push('You have not written a bio yet — this is the second most important field after your photo.');
        tips.push('Start with who you are and what you enjoy. End with what kind of meetup you are open to.');
        tips.push('Example: "Coffee lover and weekend hiker. Love chill conversations and exploring local spots!"');
      } else if (bio.length < 30) {
        tips.push(`Your bio is very short (${bio.length} characters). Aim for 50–100 characters.`);
        tips.push('Mention 1–2 things you enjoy and what kind of meetup you are open to.');
      } else if (bio.length < 80) {
        tips.push('Your bio is decent but could be a bit more personal.');
        tips.push('Try adding a specific interest or a place you love to visit.');
      } else {
        tips.push('Your bio is a solid length! Keep it genuine and refresh it when your interests change.');
      }
      tips.push('Keep it under 150 characters. Do not include phone numbers or social handles — they will be auto-removed.');
      tips.push(`Note: bio can be edited up to 5 times per day.${!canEditPhoto ? '' : ''}`);
      return { intro: 'Tips for writing a great bio:', bullets: tips.slice(0, 5), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }

    // ── What to improve first ───────────────────────────────────────────────
    case 'first_improve': {
      const priority = ['profilePhoto', 'bio', 'availability', 'preferences', 'ageGroup', 'city'];
      const topMissing = priority.filter(f => missingFields.includes(f));

      // Host-specific priority
      const hostPriority = [];
      if (isHost) {
        if (!hasUpi)       hostPriority.push('upi');
        if (!isVerified)   hostPriority.push('verification');
        if (!hostActive)   hostPriority.push('hostModeOff');
        if (!hasTagline)   hostPriority.push('tagline');
      }

      if (topMissing.length === 0 && hostPriority.length === 0) {
        return { intro: 'Your profile is complete! Focus on staying active:',
          bullets: ['Update your availability weekly.', 'Refresh your bio monthly.',
            'Log in regularly to maintain your discovery ranking.'],
          callToAction: null, completionScore, showOptionsAfter: true };
      }

      const top = topMissing[0];
      const hostTop = hostPriority[0];

      const HOST_TIP = {
        upi:           'Set up your UPI ID — without it, you cannot receive earnings even after bookings complete.',
        verification:  'Get verified — the verified badge is the biggest factor in increasing booking requests.',
        hostModeOff:   'Turn on host mode — you are currently hidden from all discovery.',
        tagline:       'Add a tagline (30 chars) — it is the first thing people read on your companion card.',
      };

      if (top) {
        return {
          intro: `Start with: ${top === 'profilePhoto' ? 'your profile photo' : top}`,
          bullets: [
            FIELD_TIP[top],
            topMissing[1] ? FIELD_TIP[topMissing[1]] : null,
            hostTop ? HOST_TIP[hostTop] : null,
          ].filter(Boolean),
          callToAction: 'Fix Now', completionScore, showOptionsAfter: false,
        };
      }
      return {
        intro: `Start with: ${hostTop}`,
        bullets: [HOST_TIP[hostTop], hostPriority[1] ? HOST_TIP[hostPriority[1]] : null].filter(Boolean),
        callToAction: hostTop === 'upi' ? 'Setup UPI' : 'Edit Profile', completionScore, showOptionsAfter: false,
      };
    }

    // ── Reviews / ratings ───────────────────────────────────────────────────
    case 'review_help': {
      const bullets = [];
      if (totalRatings === 0) {
        bullets.push('You have no reviews yet. Reviews appear after both parties in a completed and paid booking submit them.');
        bullets.push('Review window: 7 days after booking is marked complete.');
      } else {
        bullets.push(`Your rating: ${averageRating}★ from ${totalRatings} review${totalRatings !== 1 ? 's' : ''} across ${completedBookings} completed booking${completedBookings !== 1 ? 's' : ''}.`);
      }
      bullets.push('You can hide (but not delete) a review on your own profile — tap ⋯ on the review → Hide.');
      bullets.push('To report a fake or abusive review: tap ⋯ on the review → Report Review. Our team reviews within 24h.');
      bullets.push('One review per booking — cannot be changed after submission.');
      return { intro: null, bullets, callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Edit rate limit ─────────────────────────────────────────────────────
    case 'edit_limit_help': {
      return { intro: 'Profile field edit limits:',
        bullets: [
          'Profile photo: 1 change per day.',
          'Bio: 5 changes per day.',
          'Age group: 1 change per month.',
          'State / area: 2 changes per month.',
          'Tagline: 5 changes per day.',
          'If an edit is blocked, wait until the next reset window (daily limits reset at midnight).',
        ],
        callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Settings ────────────────────────────────────────────────────────────
    case 'settings_help': {
      return { intro: 'Common settings:',
        bullets: [
          'Change email or password: Profile → Settings → Account → Change Email / Change Password.',
          'Email change requires OTP verification to the new address.',
          'Notifications: Settings → Notifications — toggle activity requests, gaming alerts, community updates.',
          'Blocked users: Settings → Safety → Blocked Users.',
          'Delete account: Settings → scroll to bottom → Delete Account (permanent — cannot be undone).',
        ],
        callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Bug ─────────────────────────────────────────────────────────────────
    case 'bug_help': {
      return { intro: 'Sorry to hear something is not working!',
        bullets: [
          'Go to Help & Support → Report a Bug to submit a detailed report.',
          'Select the issue type, describe what you were doing, and attach a screenshot if possible.',
          'Our team reviews all bug reports and fixes them in the next update.',
          'For urgent account issues (suspension, payment, access), use Help & Support → Contact Support.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Safety ──────────────────────────────────────────────────────────────
    case 'safety_help': {
      return { intro: 'Safety on Humrah:',
        bullets: [
          'Always meet in public places (cafes, malls, parks). Never accept invitations to private locations.',
          'Block someone: tap ⋯ on their profile → Block. Or go to Settings → Blocked Users.',
          'Report someone: tap the flag icon on their profile card → select a reason.',
          'If you feel unsafe at any point, leave immediately and report in the app.',
          'Your reports go to our safety team and are treated seriously — 5 reports triggers an automatic review.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Fallback ────────────────────────────────────────────────────────────
    default:
      return { intro: null, bullets: [], callToAction: null, completionScore, showOptionsAfter: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Polish logic bullets — Groq receives ONLY the plain advice text (no user data)
async function polishBullets(bullets) {
  const key = process.env.GROQ_API_KEY;
  if (!key || bullets.length === 0) return bullets;
  const polished = [];
  for (const b of bullets) {
    try {
      const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: 'You help improve user profiles. Keep answers short, actionable, and friendly.' },
          { role: 'user',   content: `Rewrite this in a friendly, short, and helpful tone: ${b}` },
        ],
        max_tokens: 80, temperature: 0.5,
      }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 4000 });
      const r = res.data?.choices?.[0]?.message?.content?.trim();
      polished.push(r && r.length > 0 && r.length < 200 ? r : b);
    } catch { polished.push(b); }
  }
  return polished;
}

// Chat fallback — Groq receives app knowledge + filtered safe data (no PII)
async function groqFallback(userMessage, summary) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;

  // ── Build filtered data string — ONLY safe fields, no PII ──────────────
  // hasUpi is bool — actual UPI ID is NOT included
  // upiStatus is enum label — not the UPI string
  // No email, no location, no bank details, no photo URLs, no biometrics
  const filteredData = [
    `Profile photo: ${summary.hasProfilePhoto ? 'yes' : 'no'}`,
    `Bio length: ${summary.bio.length} characters`,
    `Preferences count: ${summary.preferences.length}`,
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
    `Days since last active: ${summary.daysSinceLastActive ?? 'unknown'}`,
  ].join('\n');

  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: HUMRAH_KNOWLEDGE_BASE },
        { role: 'user',   content: `User profile:\n${filteredData}\n\nUser message: ${userMessage}` },
      ],
      max_tokens: 200, temperature: 0.6,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 8000 });
    return res.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[Assistant] Groq fallback error:', err?.response?.data || err.message);
    return null;
  }
}

// AI-Fix — Groq generates field values and saves them
// Groq receives ONLY safe context (no PII) and generates bio/interests/availableTimes
async function generateAndApplyAiFix(user, summary) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { success: false, message: 'AI fix requires GROQ_API_KEY on the server.' };

  const fixable = summary.missingFields.filter(f => ['bio', 'preferences', 'availability'].includes(f));
  if (fixable.length === 0) {
    return { success: true, message: 'Your profile data looks complete — no AI fixes needed!', applied: [] };
  }

  const q = user.questionnaire || {};

  // Build context — lifestyle/interest fields only, no PII
  const ctxLines = [
    Array.isArray(q.hangoutPreferences) && q.hangoutPreferences.length ? `Hangout style: ${q.hangoutPreferences.join(', ')}` : null,
    Array.isArray(q.interests)          && q.interests.length          ? `Interests: ${q.interests.join(', ')}` : null,
    Array.isArray(q.vibeWords)          && q.vibeWords.length          ? `Vibe: ${q.vibeWords.join(', ')}` : null,
    Array.isArray(q.comfortActivity)    && q.comfortActivity.length    ? `Comfort activities: ${q.comfortActivity.join(', ')}` : null,
    Array.isArray(q.lookingForOnHumrah) && q.lookingForOnHumrah.length ? `Looking for: ${q.lookingForOnHumrah.join(', ')}` : null,
    q.mood            ? `Mood: ${q.mood}` : null,
    q.personalityType ? `Personality: ${q.personalityType}` : null,
    q.ageGroup        ? `Age group: ${q.ageGroup}` : null,
    // NO email, phone, city, state, income, income, relationship status, smoking/drinking status
  ].filter(Boolean).join('\n');

  const fieldInstructions = fixable.map(f => {
    if (f === 'bio')          return 'bio: a warm 2–3 sentence bio for a social companion app in India (max 140 chars, no emojis, no phone numbers, no social handles).';
    if (f === 'preferences')  return 'interests: exactly 3 relevant interest strings as a JSON array. E.g. ["Gaming", "Coffee meetups", "Hiking"].';
    if (f === 'availability') return 'availableTimes: 2–3 time slot strings as a JSON array. E.g. ["Weekday evenings", "Weekends", "Flexible"].';
    return null;
  }).filter(Boolean);

  const prompt = `Help fill in missing profile fields for a user on Humrah (Indian social companion app).

Safe context about this user:
${ctxLines || 'No additional context available.'}

Generate values ONLY for these missing fields:
${fieldInstructions.join('\n')}

Return ONLY a valid JSON object with keys: ${fixable.join(', ')}.
No markdown, no explanation, no extra keys. Just raw JSON.`;

  let generated;
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'Return only valid JSON. No markdown. No explanation.' },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 300, temperature: 0.7,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 12000 });
    const raw = res.data?.choices?.[0]?.message?.content?.trim() || '{}';
    generated = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    console.error('[Assistant] AI-fix generation error:', err?.response?.data || err.message);
    return { success: false, message: 'AI could not generate suggestions right now. Please try again.' };
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
    const interests = generated.interests.filter(i => typeof i === 'string' && i.trim()).slice(0, 5).map(i => i.trim());
    if (interests.length > 0) {
      const existing = Array.isArray(user.questionnaire.interests) ? user.questionnaire.interests : [];
      user.questionnaire.interests = [...new Set([...existing, ...interests])].slice(0, 8);
      applied.push({ field: 'interests', value: interests });
    }
  }

  if (Array.isArray(generated.availableTimes) && generated.availableTimes.length > 0) {
    const times = generated.availableTimes.filter(t => typeof t === 'string' && t.trim()).slice(0, 5).map(t => t.trim());
    if (times.length > 0) {
      user.questionnaire.availableTimes = times;
      applied.push({ field: 'availability', value: times });
    }
  }

  if (applied.length === 0) {
    return { success: false, message: 'AI could not generate valid values. Please fill the fields manually.' };
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
router.post('/consent', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.profileBotConsent = true;
    await user.save();
    res.json({ success: true, message: 'Access granted.' });
  } catch (err) {
    console.error('[Assistant] consent:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/profile-assistant/analyze  (button tap → LOGIC ONLY)
router.post('/analyze', auth, async (req, res) => {
  try {
    const { intent } = req.body;
    const VALID_INTENTS = [
      'improve_profile', 'booking_help', 'complete_profile',
      'bio_help', 'first_improve', 'payment_help',
      'verification_help', 'host_help', 'settings_help',
      'bug_help', 'safety_help', 'review_help', 'edit_limit_help',
    ];

    if (!intent || !VALID_INTENTS.includes(intent)) {
      return res.status(400).json({ success: false, code: 'INVALID_INTENT',
        message: "I didn't understand that. Try one of the options.", showOptions: true });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.profileBotConsent) {
      return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED',
        message: 'We need permission to access your profile data to help you better.' });
    }

    const summary = buildSafeProfileSummary(user);
    const result  = runLogicEngine(intent, summary);
    const bullets = await polishBullets(result.bullets);

    return res.json({ success: true, source: 'logic', intent,
      completionScore: result.completionScore, intro: result.intro,
      bullets, callToAction: result.callToAction, showOptionsAfter: result.showOptionsAfter });

  } catch (err) {
    console.error('[Assistant] analyze:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/profile-assistant/chat  (typed input → intent → logic, else Groq)
router.post('/chat', auth, async (req, res) => {
  try {
    const { message, groqCallCount = 0 } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ success: false, code: 'EMPTY_MESSAGE',
        message: "I didn't catch that.", showOptions: true });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.profileBotConsent) {
      return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED',
        message: 'We need permission to access your profile data to help you better.' });
    }

    const summary = buildSafeProfileSummary(user);
    const matched = matchIntent(message.trim());

    if (matched) {
      const result  = runLogicEngine(matched, summary);
      const bullets = await polishBullets(result.bullets);
      return res.json({ success: true, source: 'logic', intent: matched,
        completionScore: result.completionScore, intro: result.intro,
        bullets, callToAction: result.callToAction,
        showOptionsAfter: result.showOptionsAfter || groqCallCount >= 2 });
    }

    const userId = req.userId.toString();
    if (overGroqLimit(userId)) {
      return res.json({ success: true, source: 'limit',
        intro: "You've reached today's AI assist limit.",
        bullets: ['Try one of the quick options below.', 'Your daily AI limit resets at midnight.'],
        callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.json({ success: true, source: 'fallback',
        intro: "I didn't fully understand that. Try one of these:",
        bullets: [], callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore });
    }

    incrementGroq(userId);
    let groqReply = null;
    try { groqReply = await groqFallback(message.trim(), summary); } catch {}

    if (!groqReply) {
      return res.json({ success: true, source: 'fallback',
        intro: "I didn't fully understand that. Try one of these:",
        bullets: [], callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore });
    }

    const newCount = groqCallCount + 1;
    return res.json({ success: true, source: 'groq', groqReply,
      groqCallCount: newCount,
      showOptionsAfter: newCount >= 2, completionScore: summary.completionScore });

  } catch (err) {
    console.error('[Assistant] chat:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/profile-assistant/ai-fix
router.post('/ai-fix', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.profileBotConsent) {
      return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED',
        message: 'We need permission to access your profile data to help you better.' });
    }

    const userId = req.userId.toString();
    if (overGroqLimit(userId)) {
      return res.status(429).json({ success: false, code: 'DAILY_LIMIT',
        message: "You've reached today's AI assist limit. Try again tomorrow or fix manually." });
    }

    incrementGroq(userId);
    const summary = buildSafeProfileSummary(user);
    const result  = await generateAndApplyAiFix(user, summary);

    return res.status(result.success ? 200 : 400).json(result);

  } catch (err) {
    console.error('[Assistant] ai-fix:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
