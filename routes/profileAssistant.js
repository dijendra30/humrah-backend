// routes/profileAssistant.js
// ─────────────────────────────────────────────────────────────────────────────
// Profile Assistant — full knowledge of the Humrah app.
//
// ✅ MODEL: llama-3.1-8b-instant  (llama3-8b-8192 was decommissioned)
//
// Endpoints:
//   POST /consent   → store profileBotConsent = true
//   POST /analyze   → button tap → LOGIC ONLY (Groq polishes wording only)
//   POST /chat      → typed input → keyword intent → LOGIC, else Groq fallback
//   POST /ai-fix    → Groq generates & saves field values automatically
//
// The assistant knows the ENTIRE Humrah app:
//   • Profile fields, profile completion, questionnaire sections
//   • UPI / earnings / payment setup
//   • Bookings, companion/host mode, activity host features
//   • Verification (photo ID)
//   • Community guidelines, safety, blocked users
//   • Gaming sessions, movie sessions, food posts
//   • Settings screens: email, password, notifications
//   • Bug reporting, help center, contact support
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
const groqDailyUsage   = new Map(); // userId → { date: 'YYYY-MM-DD', count }

const getTodayStr = () => new Date().toISOString().slice(0, 10);

function groqCallsToday(userId) {
  const e = groqDailyUsage.get(userId);
  return (!e || e.date !== getTodayStr()) ? 0 : e.count;
}
function incrementGroq(userId) {
  const today = getTodayStr();
  const e     = groqDailyUsage.get(userId);
  groqDailyUsage.set(userId, (!e || e.date !== today)
    ? { date: today, count: 1 }
    : { ...e, count: e.count + 1 });
}
function overGroqLimit(userId) { return groqCallsToday(userId) >= GROQ_DAILY_LIMIT; }

// ─────────────────────────────────────────────────────────────────────────────
// HUMRAH APP KNOWLEDGE BASE
// This is what makes the assistant "know" the entire app.
// Used as the Groq system prompt so AI answers correctly about any feature.
// ─────────────────────────────────────────────────────────────────────────────

const HUMRAH_KNOWLEDGE_BASE = `
You are the Profile Assistant inside the Humrah social companion app.
You know EVERYTHING about how this app works. Answer any question a user has about their profile, features, or problems.
Keep answers short (3–5 lines max), friendly, and actionable.

== WHAT HUMRAH IS ==
Humrah is a social companion app for meeting people for public activities (coffee, movies, gaming, walks, etc.)
in India. Users can be MEMBER (looking to connect) or COMPANION / Activity Host (offering structured public activities).

== PROFILE FIELDS ==
Every user has:
- Profile photo (adds 3× more views — most important field)
- Bio (max 150 characters — written in "About You" section)
- Age group (18–24, 25–29, 30–34, 35–39, 40+)
- City (set during onboarding — used for local discovery)
- Language preference (Hindi, English, English & Hindi, Other)
- Hangout preferences: coffee, gaming, movies, walks, chill talk (multi-select)
- Available times: Mornings/Afternoons/Evenings/Weekends/Flexible (multi-select)
- Meetup preference: 1-on-1 or small group
- Vibe words: Friendly, Chill, Adventurous, Curious, Calm, Empathetic, Energetic, Creative
- Comfort activities: movies, music, reading, cooking, exercise, talking, sleeping
- Relax activities: scroll social, Netflix, games, call friend, walk, podcasts, chill
- Music preference: Bollywood, English, Indie, Hip-hop, EDM, Classical, Regional, None
- Budget comfort: Free/₹200–500/₹500–1000/₹1000+
- Comfort zones (meeting places): cafes, parks, malls, libraries, gyms, cultural events
- Hangout frequency: Once a week/2–3 times/Weekends only/Monthly/Rarely
- goodMeetupMeaning (free text — what makes a hangout great for you)
- vibeQuote (free text — motto you live by)
- Completion score: calculated from how many key fields are filled

== PROFILE COMPLETION ==
Profile completeness is shown as a percentage. Key items that affect it:
1. Profile photo — biggest impact
2. Bio — at least 10 characters
3. Available times — at least 1 set
4. Preferences / interests — at least 2
5. Age group
6. City
To improve profile: go to Profile → tap your photo/name → edit any field.

== ACTIVITY HOST / COMPANION MODE ==
- Users who answer "Yes, I'm interested" to "become companion" become Activity Hosts
- As a host you can offer: Coffee meetups, Movie activity, Event attendance, Travel group, Conversation meetup
- Hosts set: availability slots, price/cost-sharing, tagline (30 chars)
- Host mode can be toggled on/off via the host-status toggle on your profile
- When host mode is OFF, you are hidden from discovery
- Bookings come in when members find and request your activity

== PAYMENTS & EARNINGS ==
- Activity Hosts earn money when bookings are completed
- To receive payments: go to Profile → Setup UPI → enter your UPI ID (e.g., 9876543210@paytm, name@ybl)
- UPI format: username@bankhandle — must be valid and verified
- Payout schedule:
  • Weekly (every Monday) if earnings ≥ ₹500
  • Monthly (1st of month) if earnings < ₹500
- If payment not received: check UPI is set up and verified, check earnings dashboard, ensure bookings are marked complete
- Earnings dashboard: Profile → Earnings / Activity Insights
- Common UPI handles: @paytm, @ybl, @oksbi, @okhdfcbank, @okaxis

== VERIFICATION ==
- Photo verification: upload a selfie/ID photo for a verified badge
- Verification statuses: UNVERIFIED, PROCESSING (uploaded, under review), MANUAL_REVIEW (human review), APPROVED, REJECTED
- To verify: go to Profile → tap the unverified badge or verification section
- Verified profiles appear higher in search and get more trust

== BOOKINGS ==
- Members send activity requests to hosts
- Hosts can accept/reject requests
- After a booking: both users can leave reviews
- Reviews affect your rating and ranking in discovery
- Currently booking payment is in MVP phase — paid bookings not yet live
- "Surprise Activity" is an alternative feature for discovering random activities

== GAMING SESSIONS ==
- Users can create or join gaming sessions
- Sessions have: game type, max players, start time, chat room
- Chat room stays open 3 hours after session start time
- Session states: waiting_for_players, full, starting, in_progress, completed, expired

== MOVIE SESSIONS ==
- Users can create movie sessions: pick a movie + nearby theatre
- Others can join and chat in the session
- Movies are fetched from TMDB (Bollywood + trending India movies)
- Nearby theatres found using GPS location

== FOOD POSTS ==
- Users can post food discoveries (photos of food at cafes, restaurants, etc.)
- Each post: photo, caption (120 chars max), place name, location, price range
- Posts expire after 48 hours (auto-deleted by system)
- Feed shows nearby posts within 15 km

== COMMUNITY GUIDELINES ==
- No harassment, no explicit content, no sharing personal contact info (phone/social handles)
- Public places only for meetups
- Users who violate get warnings → suspension → ban
- Report any user via the flag icon on their profile card

== SAFETY ==
- Always meet in public places
- Tell a friend/family where you're going
- Use in-app report if someone behaves inappropriately
- Block users: Profile → Settings → Blocked Users
- Report a bug: Help & Support → Report a Bug

== SETTINGS SCREENS ==
- Account Settings: Change Email, Change Password, Notification Preferences
- Safety: Blocked Users, Safety Tips, Community Guidelines
- Help & Support: Help Center, Contact Support (here!), Report a Bug
- Notifications can be toggled: Activity Requests, Gaming Alerts, Community Activity, App Updates

== COMMON PROBLEMS & SOLUTIONS ==
Q: Why am I not getting bookings?
A: Most common reasons: no profile photo, short or missing bio, no availability set, too few interests. Also: ensure host mode is ON and city is correct.

Q: Why is payment not received?
A: Check you have set up UPI (Profile → Setup UPI). UPI must be valid format and verified. Check earnings ≥ ₹500 for weekly payout. Contact support if still not resolved.

Q: How do I set up UPI?
A: Go to Profile → tap "Setup UPI" or look for the wallet icon. Enter your UPI ID in format username@bankhandle. Tap Verify UPI.

Q: My verification is stuck / rejected?
A: PROCESSING means your photo is under review (can take up to 48h). REJECTED means the photo was unclear — retake with better lighting, clear face. MANUAL_REVIEW means a human is reviewing it.

Q: How do I become an Activity Host?
A: Complete your profile → in the questionnaire section "Activity Host Mode" → answer "Yes, I'm interested". Then fill in your availability, what activities you offer, and your tagline.

Q: How do I toggle host mode on/off?
A: Go to your Profile → find the host mode toggle. When off, you won't appear in companion/host discovery.

Q: How do I delete my account?
A: Profile → Settings → scroll to bottom → Delete Account. This is permanent.

Q: How do I change my email or password?
A: Profile → Settings (gear icon) → Account → Change Email or Change Password.

Q: How do I block someone?
A: Tap the three-dot (⋯) or flag icon on their profile → Block. Or go to Settings → Blocked Users to manage.

Q: My app is crashing / something is broken?
A: Please go to Help & Support → Report a Bug and submit a detailed report with what you were doing. You can attach a screenshot.

Q: How do I improve my bio?
A: Keep it genuine, 50–100 characters, mention 1–2 interests and what kind of meetup you're open to. Example: "Coffee lover and weekend hiker. Down for chill meetups and real conversations!"

Q: What are vibe words?
A: Short personality tags (Friendly, Chill, Adventurous, etc.) that help people quickly understand your energy. Pick 3 that feel most like you.

Q: How does profile discovery work?
A: Humrah shows profiles nearby based on your city. Higher completion score, verified badge, and active status all improve your ranking.
`;

// ─────────────────────────────────────────────────────────────────────────────
// SAFE PROFILE SUMMARY (ALLOWED_FIELDS only — no PII)
// ─────────────────────────────────────────────────────────────────────────────

function buildSafeProfileSummary(user) {
  const q = user.questionnaire || {};

  const hasProfilePhoto = !!user.profilePhoto;
  const bio             = (q.bio || '').trim();
  const preferences     = [
    ...(Array.isArray(q.hangoutPreferences) ? q.hangoutPreferences : []),
    ...(Array.isArray(q.interests)          ? q.interests          : []),
    ...(Array.isArray(q.comfortActivity)    ? q.comfortActivity    : []),
  ].filter(Boolean);
  const availability = Array.isArray(q.availableTimes) ? q.availableTimes : [];

  // Extended context for better logic decisions (still no PII)
  const isHost             = q.becomeCompanion === "Yes, I'm interested";
  const hasUpi             = !!(user.upiId || user.paymentInfo?.upiId);
  const isVerified         = user.verified === true;
  const verificationStatus = user.photoVerificationStatus || 'none';
  const hostActive         = user.hostActive !== false;
  const hasTagline         = !!q.tagline;
  const hasVibeWords       = Array.isArray(q.vibeWords) && q.vibeWords.length > 0;
  const hasComfortZones    = Array.isArray(q.comfortZones) && q.comfortZones.length > 0;
  const hasCity            = !!q.city;
  const hasAgeGroup        = !!q.ageGroup;

  const missingFields = [];
  if (!hasProfilePhoto)          missingFields.push('profilePhoto');
  if (bio.length < 10)           missingFields.push('bio');
  if (availability.length === 0) missingFields.push('availability');
  if (preferences.length < 2)   missingFields.push('preferences');
  if (!hasAgeGroup)              missingFields.push('ageGroup');
  if (!hasCity)                  missingFields.push('city');

  const completionScore = Math.round(((6 - missingFields.length) / 6) * 100);

  // Extra missing for hosts
  const hostMissingFields = [];
  if (isHost) {
    if (!hasTagline)           hostMissingFields.push('tagline');
    if (!hasComfortZones)      hostMissingFields.push('comfortZones');
    if (!hasUpi)               hostMissingFields.push('upi');
    if (!isVerified)           hostMissingFields.push('verification');
  }

  return {
    hasProfilePhoto, bio, preferences, availability,
    completionScore, missingFields,
    isHost, hasUpi, isVerified, verificationStatus,
    hostActive, hasTagline, hasVibeWords, hasComfortZones,
    hasCity, hasAgeGroup, hostMissingFields,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD INTENT MATCHER
// Returns one of the known intent strings or null (→ Groq fallback)
// ─────────────────────────────────────────────────────────────────────────────

function matchIntent(msg) {
  const l = msg.toLowerCase().trim();

  // Payment / UPI / earnings
  if (/\b(payment|upi|earning|payout|money|wallet|₹|rupee|not receiv|not paid|setup upi|settle)\b/.test(l))
    return 'payment_help';

  // Verification
  if (/\b(verif|badge|id proof|selfie|stuck|processing|rejected|manual review)\b/.test(l))
    return 'verification_help';

  // Host / companion mode
  if (/\b(host|companion|activ host|become host|host mode|toggle|turn on host|offer activit)\b/.test(l))
    return 'host_help';

  // Booking issues
  if (/\b(booking|bookings|not getting|no booking|why.{0,25}book|more booking|get booking|request)\b/.test(l))
    return 'booking_help';

  // Bio writing
  if (/\b(bio|write bio|better bio|help.*bio|bio help|about me)\b/.test(l))
    return 'bio_help';

  // Priority / what first
  if (/\b(first|priority|what.*improve|where.*start|start with|most important)\b/.test(l))
    return 'first_improve';

  // Profile completion
  if (/\b(complet|missing|fill|incomplete|finish|setup|set up|percent|%|score)\b/.test(l))
    return 'complete_profile';

  // Profile improvement
  if (/\b(improv|better|tips|help|profile|enhance|update|how to|what should|suggestion)\b/.test(l))
    return 'improve_profile';

  // Settings / account
  if (/\b(password|email|notif|setting|account|change email|change pass)\b/.test(l))
    return 'settings_help';

  // Bug / crash / broken
  if (/\b(bug|crash|broken|not working|error|issue|problem|report bug)\b/.test(l))
    return 'bug_help';

  // Safety / block / report
  if (/\b(block|report|harass|unsafe|safety|ban|suspend)\b/.test(l))
    return 'safety_help';

  return null; // unknown → Groq
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIC ENGINE — deterministic, no AI involved
// ─────────────────────────────────────────────────────────────────────────────

function runLogicEngine(intent, s) {
  const {
    missingFields, completionScore, hasProfilePhoto, bio,
    preferences, availability, isHost, hasUpi, isVerified,
    verificationStatus, hostActive, hostMissingFields,
    hasTagline, hasCity, hasAgeGroup,
  } = s;

  const FIELD_TIP = {
    profilePhoto: 'Add a clear profile photo — profiles with photos get 3× more views.',
    bio:          'Write a short bio (at least 10 characters) so people know who you are.',
    availability: 'Set your available time slots so people know when you can meet.',
    preferences:  'Add at least 2 interests or hangout preferences.',
    ageGroup:     'Set your age group for better match suggestions.',
    city:         'Add your city so nearby people can discover you.',
  };

  switch (intent) {

    // ── Complete my profile ─────────────────────────────────────────────────
    case 'complete_profile': {
      if (missingFields.length === 0) {
        return { intro: `Your profile is ${completionScore}% complete — all set! 🎉`,
          bullets: ['Refresh your bio every few weeks to stay relevant.',
            'Keep availability updated to attract more connections.',
            isHost && !hasUpi ? 'Set up your UPI ID to start receiving earnings.' : null,
          ].filter(Boolean),
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
        : bio.length < 60 ? 'Your bio is a bit short. Add a hobby or your favourite activity to personalise it.'
        : 'Your bio is solid. Keep it authentic and refresh it when your interests change.');
      tips.push(availability.length === 0
        ? 'Set your availability so people know when to reach out.'
        : 'Good — you have availability set. Update it whenever your schedule changes.');
      tips.push(preferences.length < 2
        ? 'Add at least 2 interests to improve your discovery ranking.'
        : preferences.length < 5 ? 'A few more interests help people find common ground with you.'
        : 'Great variety of interests! Keep them current.');
      if (isHost && !hasUpi) tips.push('As a host, set up your UPI ID so you can receive earnings from bookings.');
      if (isHost && !isVerified) tips.push('Get verified — the verified badge builds trust and increases bookings.');
      return { intro: null, bullets: tips.slice(0, 5), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }

    // ── Why no bookings ─────────────────────────────────────────────────────
    case 'booking_help': {
      const reasons = [];
      if (!hasProfilePhoto)          reasons.push('No profile photo — the top reason people skip a profile.');
      if (bio.length < 10)           reasons.push('Missing or very short bio — people want to know who they are meeting.');
      if (availability.length === 0) reasons.push('No availability set — people cannot see when you are free.');
      if (preferences.length < 2)   reasons.push('Too few interests — add more so the system matches you better.');
      if (isHost && !hostActive)     reasons.push('Your host mode is turned OFF — turn it ON in your profile so you appear in discovery.');
      if (isHost && !isVerified)     reasons.push('You are not verified — getting a verified badge builds trust with potential bookers.');
      if (isHost && !hasUpi)         reasons.push('No UPI set up — set it up so payments can be processed when bookings complete.');
      if (isHost && !hasTagline)     reasons.push('Add a catchy tagline (30 chars) to your host profile — it appears on your companion card.');
      if (reasons.length === 0) {
        return { intro: 'Your profile looks great! 👍 Tips to boost bookings further:',
          bullets: ['Log in regularly — active profiles rank higher in discovery.',
            'Update your availability often so people know you are reachable.',
            'Refresh your bio occasionally to keep it feeling current.',
            'Ask satisfied connections to leave you a review — reviews boost ranking.'],
          callToAction: null, completionScore, showOptionsAfter: true };
      }
      return { intro: 'Here are the likely reasons you are not getting bookings:',
        bullets: reasons.slice(0, 5), callToAction: 'Fix Issues', completionScore, showOptionsAfter: false };
    }

    // ── Payment / UPI / Earnings ────────────────────────────────────────────
    case 'payment_help': {
      if (!isHost) {
        return { intro: 'Payments are for Activity Hosts only.',
          bullets: [
            'Only users in "Activity Host" mode can earn from bookings.',
            'To become a host: complete your profile questionnaire and select "Yes, I\'m interested" in the Activity Host section.',
            'Once you are a host, you can set up your UPI ID to receive earnings.',
          ],
          callToAction: null, completionScore, showOptionsAfter: true };
      }
      if (!hasUpi) {
        return { intro: 'You have not set up your UPI ID yet.',
          bullets: [
            'To receive earnings, go to Profile → Setup UPI.',
            'Enter your UPI ID in format: username@bankhandle (e.g., name@ybl, 9876543210@paytm).',
            'Your UPI must be verified before payouts can be processed.',
          ],
          callToAction: 'Setup UPI', completionScore, showOptionsAfter: false };
      }
      return { intro: 'Your UPI is set up. Here is how payouts work:',
        bullets: [
          'Earnings ≥ ₹500: paid out every Monday automatically.',
          'Earnings < ₹500: paid out on the 1st of each month.',
          'Check your Earnings Dashboard in your profile to track pending amounts.',
          'If a payout is missing after the schedule date, contact support via Help & Support → Contact Support.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Verification ────────────────────────────────────────────────────────
    case 'verification_help': {
      const tips = [];
      if (isVerified) {
        tips.push('You are already verified! ✅ Your verified badge is visible on your profile card.');
        tips.push('Verified profiles appear higher in search results and get more trust from other users.');
      } else if (verificationStatus === 'pending' || verificationStatus === 'processing') {
        tips.push('Your verification photo has been submitted and is currently under review.');
        tips.push('Review usually takes up to 48 hours. You will be notified once it is complete.');
        tips.push('Make sure your photo clearly shows your face and is well-lit.');
      } else if (verificationStatus === 'manual_review') {
        tips.push('Your verification is in manual review — a team member is looking at it.');
        tips.push('This takes a little longer than automated review. Please wait for a notification.');
      } else if (verificationStatus === 'rejected') {
        tips.push('Your verification was rejected. Common reasons: photo was blurry, face not visible, or lighting was poor.');
        tips.push('Please re-submit a clear, well-lit selfie or ID photo.');
        tips.push('Go to your Profile → tap the unverified badge → upload a new photo.');
      } else {
        tips.push('You are not yet verified. Getting verified adds a badge and boosts your trust score.');
        tips.push('Go to Profile → tap the unverified badge or the verification section.');
        tips.push('Upload a clear selfie or a photo showing your face clearly.');
      }
      return { intro: null, bullets: tips, callToAction: isVerified ? null : 'Get Verified', completionScore, showOptionsAfter: false };
    }

    // ── Host / Activity Host mode ───────────────────────────────────────────
    case 'host_help': {
      if (!isHost) {
        return { intro: 'You are not in Activity Host mode yet.',
          bullets: [
            'To become a host: go to Profile → Edit Profile → questionnaire → "Activity Host Mode" section.',
            'Select "Yes, I\'m interested" to enable host features.',
            'Then fill in: what activities you offer, your availability, tagline, and cost-sharing preference.',
            'Once set up, set up your UPI ID so you can receive earnings.',
          ],
          callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
      }
      const hostTips = [];
      if (!hostActive)     hostTips.push('Your host mode is currently OFF — turn it ON in your profile to appear in discovery.');
      if (!isVerified)     hostTips.push('Get verified — a verified badge increases bookings significantly.');
      if (!hasUpi)         hostTips.push('Set up your UPI ID (Profile → Setup UPI) to receive earnings.');
      if (!hasTagline)     hostTips.push('Add a tagline (30 chars) — it appears on your companion card and attracts bookings.');
      if (hostTips.length === 0) {
        hostTips.push('Your host profile is fully set up! Keep your host mode ON and availability updated.');
        hostTips.push('Respond to booking requests quickly — faster responses improve your ranking.');
        hostTips.push('Encourage satisfied users to leave reviews — reviews directly boost discovery ranking.');
      }
      return { intro: 'Here is your host profile status:', bullets: hostTips.slice(0, 5), callToAction: null, completionScore, showOptionsAfter: false };
    }

    // ── Bio help ────────────────────────────────────────────────────────────
    case 'bio_help': {
      const tips = [];
      if (bio.length === 0) {
        tips.push('You have not written a bio yet. This is the second most important field after your photo.');
        tips.push('Start with what kind of person you are and what you enjoy doing.');
        tips.push('Example: "Coffee lover and weekend hiker. Looking for chill meetups and real conversations!"');
      } else if (bio.length < 30) {
        tips.push(`Your bio is very short (${bio.length} characters). Aim for 50–100 characters.`);
        tips.push('Mention 1–2 things you enjoy and what kind of meetup you are open to.');
      } else if (bio.length < 80) {
        tips.push('Your bio is decent but could be a bit more personal.');
        tips.push('Try mentioning a specific interest or a place you love to hang out at.');
      } else {
        tips.push('Your bio is a solid length! Keep it genuine and update it if your interests change.');
        tips.push('End with something that invites people to connect — e.g. "Always up for a good coffee chat!"');
      }
      tips.push('Keep it under 150 characters and avoid sharing contact details (phone, social handles) — they will be removed automatically.');
      return { intro: 'Tips for writing a great bio:', bullets: tips, callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }

    // ── What to improve first ───────────────────────────────────────────────
    case 'first_improve': {
      const priority = ['profilePhoto', 'bio', 'availability', 'preferences', 'ageGroup', 'city'];
      const topMissing = priority.filter(f => missingFields.includes(f));
      const hostPriority = ['upi', 'verification', 'tagline'];
      const topHostMissing = isHost ? hostPriority.filter(f =>
        (f === 'upi' && !isHost) ? false :
        (f === 'verification' && !isVerified) ? true :
        (f === 'tagline' && !hasTagline) ? true :
        (f === 'upi' && !hasUpi) ? true : false
      ) : [];

      if (topMissing.length === 0 && topHostMissing.length === 0) {
        return { intro: 'Your profile is complete! Focus on staying active:',
          bullets: ['Update your availability weekly.', 'Refresh your bio every month.',
            'Log in regularly to appear higher in search.'],
          callToAction: null, completionScore, showOptionsAfter: true };
      }
      const top = topMissing[0] || topHostMissing[0];
      const tipMap = {
        profilePhoto:   'Add your profile photo first — it has the single biggest impact on discovery.',
        bio:            'Write your bio next — people decide whether to connect based on your bio.',
        availability:   'Set your availability — without it, people cannot know when to reach out.',
        preferences:    'Add at least 2 interests so the system can match you with the right people.',
        ageGroup:       'Set your age group for better match suggestions.',
        city:           'Add your city — this is how local users find you.',
        upi:            'Set up your UPI ID so you can receive earnings when bookings are completed.',
        verification:   'Get verified — the badge builds trust and directly increases bookings.',
        tagline:        'Add a host tagline (30 chars) — it is the first thing people see on your companion card.',
      };
      const secondTip = topMissing[1] ? FIELD_TIP?.[topMissing[1]] || `Fill in your ${topMissing[1]}.` : null;
      return {
        intro: `Start with: ${top === 'profilePhoto' ? 'your profile photo' : top}`,
        bullets: [tipMap[top] || `Fill in your ${top}.`, secondTip].filter(Boolean),
        callToAction: 'Fix Now', completionScore, showOptionsAfter: false,
      };
    }

    // ── Settings / account ──────────────────────────────────────────────────
    case 'settings_help': {
      return { intro: 'Here is how to access common settings:',
        bullets: [
          'Change email or password: Profile → Settings (gear icon) → Account → Change Email or Change Password.',
          'Notification preferences: Settings → Notifications — toggle activity requests, gaming alerts, etc.',
          'Block a user: tap ⋯ on their profile or Settings → Blocked Users.',
          'Delete account: Settings → scroll to bottom → Delete Account (this is permanent).',
        ],
        callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Bug / crash ─────────────────────────────────────────────────────────
    case 'bug_help': {
      return { intro: 'Sorry to hear something is not working!',
        bullets: [
          'Go to Help & Support → Report a Bug to submit a detailed report.',
          'Describe what you were doing and what happened.',
          'Attach a screenshot if possible — it helps our team fix it faster.',
          'Our team reviews all bug reports and will fix it in the next update.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Safety / block / report ─────────────────────────────────────────────
    case 'safety_help': {
      return { intro: 'Here is how to stay safe on Humrah:',
        bullets: [
          'Always meet in public places (cafes, parks, malls — never private locations).',
          'To block someone: tap ⋯ on their profile → Block, or Settings → Blocked Users.',
          'To report someone: tap the flag icon on their profile card and select a reason.',
          'If you feel unsafe in any situation, leave and report it immediately in the app.',
          'Your reports are reviewed by our safety team and handled seriously.',
        ],
        callToAction: null, completionScore, showOptionsAfter: true };
    }

    // ── Fallback ────────────────────────────────────────────────────────────
    default:
      return { intro: null, bullets: [], callToAction: null, completionScore, showOptionsAfter: true };
  }
}

// Expose FIELD_TIP for first_improve fallback
const FIELD_TIP = {
  profilePhoto: 'Add a clear profile photo — profiles with photos get 3× more views.',
  bio:          'Write a short bio (at least 10 characters) so people know who you are.',
  availability: 'Set your available time slots so people know when you can meet.',
  preferences:  'Add at least 2 interests or hangout preferences.',
  ageGroup:     'Set your age group for better match suggestions.',
  city:         'Add your city so nearby people can discover you.',
};

// ─────────────────────────────────────────────────────────────────────────────
// GROQ HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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

async function groqFallback(userMessage, summary) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;

  // Filtered safe data only (no PII)
  const filteredData = [
    `Profile photo: ${summary.hasProfilePhoto ? 'yes' : 'no'}`,
    `Bio length: ${summary.bio.length} characters`,
    `Preferences count: ${summary.preferences.length}`,
    `Availability slots: ${summary.availability.length}`,
    `Completion: ${summary.completionScore}%`,
    `Missing fields: ${summary.missingFields.join(', ') || 'none'}`,
    `Is host: ${summary.isHost}`,
    `UPI set up: ${summary.hasUpi}`,
    `Verified: ${summary.isVerified}`,
    `Verification status: ${summary.verificationStatus}`,
  ].join('\n');

  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: HUMRAH_KNOWLEDGE_BASE },
        { role: 'user',   content: `User profile: ${filteredData}\nUser message: ${userMessage}` },
      ],
      max_tokens: 200, temperature: 0.6,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 8000 });
    return res.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[Assistant] Groq fallback error:', err?.response?.data || err.message);
    return null;
  }
}

async function generateAndApplyAiFix(user, summary) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { success: false, message: 'AI fix requires GROQ_API_KEY on the server.' };

  const fixable = summary.missingFields.filter(f => ['bio', 'preferences', 'availability'].includes(f));
  if (fixable.length === 0) {
    return { success: true, message: 'Your profile data looks complete — no AI fixes needed!', applied: [] };
  }

  const q = user.questionnaire || {};
  const ctxLines = [
    q.hangoutPreferences?.length ? `Hangout: ${q.hangoutPreferences.join(', ')}` : null,
    q.interests?.length           ? `Interests: ${q.interests.join(', ')}`        : null,
    q.mood                        ? `Mood: ${q.mood}`                             : null,
    q.personalityType             ? `Personality: ${q.personalityType}`           : null,
    q.lookingForOnHumrah?.length  ? `Looking for: ${q.lookingForOnHumrah.join(', ')}` : null,
    q.vibeWords?.length           ? `Vibe words: ${q.vibeWords.join(', ')}`       : null,
    q.comfortActivity?.length     ? `Comfort: ${q.comfortActivity.join(', ')}`    : null,
  ].filter(Boolean).join('\n');

  const fieldInstructions = fixable.map(f => {
    if (f === 'bio')          return 'bio: a warm 2–3 sentence bio for a social companion app in India (max 140 chars, no emojis, no phone numbers).';
    if (f === 'preferences')  return 'interests: exactly 3 relevant interest strings as a JSON array. Examples: ["Gaming", "Coffee meetups", "Hiking"].';
    if (f === 'availability') return 'availableTimes: 2–3 time slot strings as a JSON array. Examples: ["Weekday evenings", "Weekends", "Flexible"].';
    return null;
  }).filter(Boolean);

  const prompt = `You are helping a user on Humrah (an Indian social companion app) fill in missing profile fields.

Context about this user (no personal info):
${ctxLines || 'No additional context available.'}

Generate values for these missing fields:
${fieldInstructions.join('\n')}

Return ONLY a valid JSON object with keys: ${fixable.join(', ')}.
No markdown, no explanation, no extra keys. Just the raw JSON.`;

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
    const raw   = res.data?.choices?.[0]?.message?.content?.trim() || '{}';
    generated   = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    console.error('[Assistant] AI-fix generation error:', err?.response?.data || err.message);
    return { success: false, message: 'AI could not generate suggestions right now. Please try again.' };
  }

  if (!user.questionnaire) user.questionnaire = {};
  const applied = [];

  if (generated.bio && typeof generated.bio === 'string') {
    const bio = generated.bio.trim().slice(0, 140);
    if (bio.length >= 10 && !/https?:\/\//.test(bio)) {
      user.questionnaire.bio = bio;
      applied.push({ field: 'bio', value: bio });
    }
  }
  if (Array.isArray(generated.interests) && generated.interests.length > 0) {
    const interests = generated.interests.filter(i => typeof i === 'string').slice(0, 5).map(i => i.trim());
    if (interests.length > 0) {
      const existing = Array.isArray(user.questionnaire.interests) ? user.questionnaire.interests : [];
      user.questionnaire.interests = [...new Set([...existing, ...interests])].slice(0, 8);
      applied.push({ field: 'interests', value: interests });
    }
  }
  if (Array.isArray(generated.availableTimes) && generated.availableTimes.length > 0) {
    const times = generated.availableTimes.filter(t => typeof t === 'string').slice(0, 5).map(t => t.trim());
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

// POST /api/profile-assistant/analyze   (button tap → LOGIC ONLY)
router.post('/analyze', auth, async (req, res) => {
  try {
    const { intent } = req.body;
    const valid = [
      'improve_profile', 'booking_help', 'complete_profile',
      'bio_help', 'first_improve', 'payment_help',
      'verification_help', 'host_help', 'settings_help',
      'bug_help', 'safety_help',
    ];
    if (!intent || !valid.includes(intent)) {
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

// POST /api/profile-assistant/chat   (typed → intent match → logic, else Groq)
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
    return res.json({ success: true, source: 'groq', groqReply,
      groqCallCount: groqCallCount + 1,
      showOptionsAfter: groqCallCount + 1 >= 2, completionScore: summary.completionScore });
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
