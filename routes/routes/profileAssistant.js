// routes/profileAssistant.js
// ─────────────────────────────────────────────────────────────────────────────
// Profile Assistant v2 — redesigned with health scores, nudges, bio AI,
// match explanation, conversation starters, trust signals, evolution.
//
// Original endpoints (preserved):
//   POST /consent   → store profileBotConsent = true
//   POST /analyze   → logic engine (button tap)
//   POST /chat      → keyword intent → logic, else Groq fallback
//   POST /ai-fix    → Groq generates + saves safe field values
//
// New endpoints:
//   GET  /health           → 4-dimension profile health scores
//   GET  /nudges           → detected gaps + soft suggestions
//   POST /bio              → AI bio rewrite (raw text + tone)
//   GET  /trust            → user's own trust signals
//   GET  /match/:userId    → overlap explanation for a match
//   GET  /starters/:userId → conversation starters for a user pair
//   GET  /evolution        → behavioral pattern suggestions
//
// SECURITY — fields NEVER sent anywhere:
//   email, password, googleId, facebookId, fcmTokens,
//   pendingEmail, pendingEmailOTP, last_known_lat/lng,
//   verificationEmbedding, verificationPhoto, paymentInfo.upiId,
//   paymentInfo.bankAccount, moderationFlags.violations[].originalValue,
//   suspensionInfo, banInfo, safetyDisclaimerAcceptances,
//   videoVerificationConsents, blockedUsers
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { auth } = require('../middleware/auth');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const User    = require('../models/User');

const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (_req, res) => res.status(429).json({
    success: false, code: 'RATE_LIMITED',
    message: 'Slow down — wait a moment and try again.',
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_MODEL       = 'llama-3.1-8b-instant';
const GROQ_DAILY_LIMIT = 5;

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
  User.updateOne({ _id: user._id }, { groqUsage: user.groqUsage }).catch(() => {});
}

async function overGroqLimit(user) {
  return (await groqCallsToday(user)) >= GROQ_DAILY_LIMIT;
}

// ─────────────────────────────────────────────────────────────────────────────
// HUMRAH KNOWLEDGE BASE
// ─────────────────────────────────────────────────────────────────────────────

const HUMRAH_KNOWLEDGE_BASE = `
You are the Profile Assistant inside Humrah — an Indian social companion app for meeting
people for safe, public activities (coffee, movies, gaming, walks, food spots, etc.).
You know EVERYTHING about the app. Answer questions about profile, payments, bookings,
verification, settings, bugs, or safety in 3-5 lines. Be friendly, clear, and actionable.
Never make up features that don't exist. If unsure, suggest contacting support.

PROFILE & COMPLETION:
Key fields: profile photo, bio (max 150 chars), age group, city/state/area,
hangout preferences, available times, meetup preference (1-on-1 or group),
vibe words, comfort activities, relax activities, music preference, budget comfort,
comfort zones, hangout frequency, goodMeetupMeaning, vibeQuote, interests, hobbies,
gender, language, personality type, mood, travel preference, pet preference,
fitness level, profession, education.
Completion score is based on 6 key fields: photo, bio, availability,
preferences (2+), age group, city.
Edit: Profile > tap your photo/name > edit any field.
Edit rate limits: profile photo 1/day, bio 5/day, age group 1/month, state/area 2/month.

ACTIVITY HOST / COMPANION MODE:
userType: MEMBER or COMPANION.
To become a host: complete questionnaire > Activity Host Mode > "Yes, I'm interested".
Hosts set: activities offered (openFor), availability slots, cost-sharing (price), tagline (30 chars).
Host toggle: Profile > host-status toggle. OFF = hidden from discovery.

PAYMENTS & EARNINGS:
Only COMPANION/Activity Hosts earn. Members do not earn.
UPI setup: Profile > Setup UPI > enter UPI ID (e.g. name@ybl, 9876543210@paytm).
Valid handles: @paytm @ybl @oksbi @okhdfcbank @okaxis.
Payout schedule: earnings >= 500 every Monday; < 500 on 1st of month.

VERIFICATION:
Statuses: not_submitted > pending > approved (or rejected or manual_review).
Face++ match: >=70% APPROVED, 60-70% MANUAL REVIEW, <60% REJECTED.
Max 3 attempts per hour.

BOOKINGS & REVIEWS:
Members send activity requests to hosts. Hosts accept/reject.
Reviews: 1-5 stars within 7 days. One per booking, cannot be edited. Can HIDE not delete.

GAMING SESSIONS:
Create/join gaming sessions. Chat open 3h after start. 2h cooldown between creates.

MOVIE SESSIONS:
Create session: pick trending movie (TMDB) + nearby theatre (Google Places).

FOOD POSTS:
Photo + caption (120 chars) + place + price. Expire after 48h. Feed within 15km.

SAFETY:
3 strikes = suspension. Report: flag icon on profile. Block: dots menu > Block.
Always meet in PUBLIC places.

SETTINGS:
Change email: Settings > Account > Change Email (OTP required).
Change password: min 8 chars, letter+number+special char.
Delete account: Settings > scroll bottom > Delete Account (permanent).
`;

// ─────────────────────────────────────────────────────────────────────────────
// SAFE PROFILE SUMMARY
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

  const missingFields = [];
  if (!hasProfilePhoto)          missingFields.push('profilePhoto');
  if (bio.length < 10)           missingFields.push('bio');
  if (availability.length === 0) missingFields.push('availability');
  if (preferences.length < 2)   missingFields.push('preferences');
  if (!q.ageGroup)               missingFields.push('ageGroup');
  if (!q.city)                   missingFields.push('city');
  const completionScore = Math.round(((6 - missingFields.length) / 6) * 100);

  const isHost     = user.userType === 'COMPANION' || q.becomeCompanion === "Yes, I'm interested";
  const hostActive = user.hostActive !== false;
  const hasTagline = !!(q.tagline && q.tagline.trim());
  const openFor    = Array.isArray(q.openFor) ? q.openFor : [];

  const vibeWords       = Array.isArray(q.vibeWords)         ? q.vibeWords         : [];
  const comfortActivity = Array.isArray(q.comfortActivity)   ? q.comfortActivity   : [];
  const relaxActivity   = Array.isArray(q.relaxActivity)     ? q.relaxActivity     : [];
  const musicPreference = Array.isArray(q.musicPreference)   ? q.musicPreference   : [];
  const comfortZones    = Array.isArray(q.comfortZones)      ? q.comfortZones      : [];
  const lookingFor      = Array.isArray(q.lookingForOnHumrah)? q.lookingForOnHumrah: [];

  const mood             = q.mood            || null;
  const personalityType  = q.personalityType || null;
  const ageGroup         = q.ageGroup        || null;
  const city             = q.city            || null;
  const meetupPreference = q.meetupPreference|| null;
  const budgetComfort    = q.budgetComfort   || null;
  const travelPreference = q.travelPreference|| null;
  const fitnessLevel     = q.fitnessLevel    || null;
  const publicPlacesOnly = q.publicPlacesOnly|| null;

  const hasUpi           = !!(user.paymentInfo && user.paymentInfo.upiId);
  const upiStatus        = (user.paymentInfo && user.paymentInfo.upiStatus)        || 'not_set';
  const pendingPayout    = (user.paymentInfo && user.paymentInfo.pendingPayout)    || 0;
  const totalEarnings    = (user.paymentInfo && user.paymentInfo.totalEarnings)    || 0;
  const completedPayouts = (user.paymentInfo && user.paymentInfo.completedPayouts) || 0;

  const isVerified           = user.verified === true;
  const verificationStatus   = user.photoVerificationStatus  || 'not_submitted';
  const verificationType     = user.verificationType         || null;
  const verificationAttempts = user.verificationAttempts     || 0;
  const lastRejectionReason  = (user.verificationRejections && user.verificationRejections.length > 0)
    ? (user.verificationRejections[user.verificationRejections.length - 1].reason || null)
    : null;

  const averageRating     = (user.ratingStats && user.ratingStats.averageRating)     || 0;
  const totalRatings      = (user.ratingStats && user.ratingStats.totalRatings)      || 0;
  const completedBookings = (user.ratingStats && user.ratingStats.completedBookings) || 0;

  const emailVerified       = user.emailVerified === true;
  const userType            = user.userType      || 'MEMBER';
  const accountStatus       = user.status        || 'ACTIVE';
  const daysSinceLastActive = user.lastActive
    ? Math.floor((Date.now() - new Date(user.lastActive).getTime()) / 86400000)
    : null;

  const photoEditedToday = (user.profileEditStats && user.profileEditStats.lastPhotoUpdate)
    ? (Date.now() - new Date(user.profileEditStats.lastPhotoUpdate).getTime()) < 86400000
    : false;
  const canEditPhoto = !photoEditedToday;

  const hostMissing = [];
  if (isHost) {
    if (!hasUpi)     hostMissing.push('upi');
    if (!isVerified) hostMissing.push('verification');
    if (!hasTagline) hostMissing.push('tagline');
    if (!hostActive) hostMissing.push('hostModeOff');
  }

  const strikeCount         = (user.moderationFlags && user.moderationFlags.strikeCount) || 0;
  const isModerationFlagged = !!(user.moderationFlags && user.moderationFlags.isFlagged);

  return {
    hasProfilePhoto, bio, preferences, availability,
    completionScore, missingFields,
    isHost, hostActive, hasTagline, openFor, hostMissing,
    hasUpi, upiStatus, pendingPayout, totalEarnings, completedPayouts,
    isVerified, verificationStatus, verificationType, verificationAttempts, lastRejectionReason,
    averageRating, totalRatings, completedBookings,
    emailVerified, userType, accountStatus, daysSinceLastActive, canEditPhoto,
    strikeCount, isModerationFlagged,
    vibeWords, lookingFor, comfortActivity, relaxActivity, musicPreference,
    comfortZones, publicPlacesOnly,
    mood, personalityType, ageGroup, city, meetupPreference, budgetComfort,
    travelPreference, fitnessLevel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE HEALTH SCORES — pure logic, no AI
// ─────────────────────────────────────────────────────────────────────────────

function buildHealthScores(s) {
  let approachability = 0;
  if (s.hasProfilePhoto)          approachability += 35;
  if (s.bio.length >= 10)         approachability += 20;
  if (s.bio.length >= 60)         approachability += 5;
  if (s.vibeWords.length >= 1)    approachability += 15;
  if (s.comfortZones.length >= 1) approachability += 15;
  if (s.preferences.length >= 2)  approachability += 10;
  approachability = Math.min(100, approachability);

  let trust = 0;
  if (s.isVerified)                trust += 40;
  else if (s.verificationStatus === 'pending') trust += 15;
  if (s.emailVerified)             trust += 20;
  if (s.publicPlacesOnly === 'Yes')trust += 15;
  if (s.comfortZones.length >= 1)  trust += 10;
  if (s.totalRatings >= 3)         trust += 10;
  else if (s.totalRatings >= 1)    trust += 5;
  trust -= s.strikeCount * 15;
  trust = Math.max(0, Math.min(100, trust));

  let conversationReadiness = 0;
  if (s.bio.length >= 30)              conversationReadiness += 30;
  else if (s.bio.length >= 10)         conversationReadiness += 15;
  if (s.preferences.length >= 3)       conversationReadiness += 25;
  else if (s.preferences.length >= 1)  conversationReadiness += 10;
  if (s.vibeWords.length >= 2)         conversationReadiness += 20;
  if (s.comfortActivity.length >= 2)   conversationReadiness += 15;
  if (s.mood)                          conversationReadiness += 5;
  if (s.personalityType)               conversationReadiness += 5;
  conversationReadiness = Math.min(100, conversationReadiness);

  let meetupReadiness = 0;
  if (s.availability.length >= 1)   meetupReadiness += 30;
  if (s.city)                       meetupReadiness += 25;
  if (s.meetupPreference)           meetupReadiness += 15;
  if (s.comfortZones.length >= 1)   meetupReadiness += 15;
  if (s.isHost && s.hostActive)     meetupReadiness += 10;
  if (s.publicPlacesOnly === 'Yes') meetupReadiness += 5;
  meetupReadiness = Math.min(100, meetupReadiness);

  const overall = Math.round((approachability + trust + conversationReadiness + meetupReadiness) / 4);

  let label;
  if (overall >= 85)      label = 'Your profile feels safe and easy to approach.';
  else if (overall >= 65) label = 'Your profile is approachable, but a few trust signals are missing.';
  else if (overall >= 45) label = 'People may hesitate — a few important details are missing.';
  else                    label = 'Your profile is hard to start conversations with.';

  return { overall, approachability, trust, conversationReadiness, meetupReadiness, label };
}

// ─────────────────────────────────────────────────────────────────────────────
// BIO SAFETY SCAN
// ─────────────────────────────────────────────────────────────────────────────

const UNSAFE_BIO_PATTERNS = [
  /\d{10}/,
  /https?:\/\//i,
  /@[a-z0-9_.]+/i,
  /\bescort\b/i,
  /\bpaid comp(any|anion)\b/i,
  /\bprivate\s+(meetup|meet|visit)\b/i,
  /\bagency\b/i,
];

function scanBioSafety(bio) {
  for (const p of UNSAFE_BIO_PATTERNS) {
    if (p.test(bio)) return { safe: false };
  }
  return { safe: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// SMART NUDGES — rule-based, no AI
// ─────────────────────────────────────────────────────────────────────────────

function buildNudges(s) {
  const nudges = [];

  if (!s.hasProfilePhoto) {
    nudges.push({ level: 'critical', field: 'profilePhoto',
      text: 'No profile photo — the single most important field.',
      action: 'Add a clear, well-lit photo of your face.' });
  }
  if (s.bio.length === 0) {
    nudges.push({ level: 'critical', field: 'bio',
      text: 'No bio — people have no idea who they would be meeting.',
      action: 'Even 1-2 sentences makes a real difference.' });
  } else if (s.bio.length < 30) {
    nudges.push({ level: 'warn', field: 'bio',
      text: `Bio is very short (${s.bio.length} chars). Hard to start a conversation.`,
      action: 'Aim for at least 50 characters.' });
  }
  if (!s.city) {
    nudges.push({ level: 'critical', field: 'city',
      text: 'City not set — people nearby cannot find you.',
      action: 'Set your city in the questionnaire.' });
  }
  if (s.availability.length === 0) {
    nudges.push({ level: 'warn', field: 'availability',
      text: 'Availability not set — people cannot tell when you are free to meet.',
      action: 'Even marking "weekends only" helps.' });
  }
  if (s.comfortZones.length === 0) {
    nudges.push({ level: 'warn', field: 'comfortZones',
      text: 'No comfort zones listed — profiles with them feel safer to approach.',
      action: 'Select at least one location type you are comfortable with.' });
  }
  if (s.preferences.length < 2) {
    nudges.push({ level: 'info', field: 'preferences',
      text: 'Few interests listed — more helps the matching system work for you.',
      action: 'Add at least 2 interests or hangout preferences.' });
  }
  if (s.vibeWords.length === 0) {
    nudges.push({ level: 'info', field: 'vibeWords',
      text: 'No vibe words set — they help people understand your social energy.',
      action: 'Add 2-3 words that describe how you like to socialise.' });
  }
  if (!s.isVerified) {
    nudges.push({ level: 'info', field: 'verification',
      text: 'Unverified — verified profiles build significantly more trust.',
      action: 'Complete your video verification.' });
  }
  if (s.bio.length > 0 && !scanBioSafety(s.bio).safe) {
    nudges.push({ level: 'critical', field: 'bioSafety',
      text: 'Bio contains disallowed content (phone number, link, or unsafe wording).',
      action: 'Remove it to avoid moderation action.' });
  }

  return nudges;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRUST SIGNALS — logic only
// ─────────────────────────────────────────────────────────────────────────────

function buildTrustSignals(s) {
  return [
    {
      label: 'Photo verified',
      status: s.isVerified ? 'ok' : (s.verificationStatus === 'pending' ? 'pending' : 'missing'),
      value: s.isVerified ? 'Verified' : (s.verificationStatus === 'pending' ? 'Pending review' : 'Not submitted'),
    },
    {
      label: 'Email verified',
      status: s.emailVerified ? 'ok' : 'missing',
      value: s.emailVerified ? 'Verified' : 'Not verified',
    },
    {
      label: 'Meetup preference',
      status: s.meetupPreference ? 'ok' : 'missing',
      value: s.meetupPreference || 'Not set',
    },
    {
      label: 'Public spaces preference',
      status: s.publicPlacesOnly === 'Yes' ? 'ok' : (s.publicPlacesOnly ? 'warn' : 'missing'),
      value: s.publicPlacesOnly || 'Not set',
    },
    {
      label: 'Comfort zones listed',
      status: s.comfortZones.length >= 1 ? 'ok' : 'missing',
      value: s.comfortZones.length >= 1 ? `${s.comfortZones.length} zone(s) set` : 'None listed',
    },
    {
      label: 'Community reviews',
      status: s.totalRatings >= 3 ? 'ok' : (s.totalRatings >= 1 ? 'warn' : 'missing'),
      value: s.totalRatings > 0
        ? `${s.averageRating.toFixed(1)} from ${s.totalRatings} review(s)`
        : 'No reviews yet',
    },
    {
      label: 'Moderation standing',
      status: s.strikeCount === 0 ? 'ok' : (s.strikeCount < 3 ? 'warn' : 'bad'),
      value: s.strikeCount === 0 ? 'Clean' : `${s.strikeCount} strike(s)`,
    },
    {
      label: 'Bio safety scan',
      status: (s.bio.length === 0 || scanBioSafety(s.bio).safe) ? 'ok' : 'bad',
      value: (s.bio.length === 0 || scanBioSafety(s.bio).safe) ? 'Clean' : 'Flagged',
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCH EXPLANATION — overlap logic, no AI
// ─────────────────────────────────────────────────────────────────────────────

function buildMatchExplanation(sA, sB) {
  const reasons = [];
  const lc = (arr) => arr.map(x => x.toLowerCase());

  const sharedActivities = sA.comfortActivity.filter(a => lc(sB.comfortActivity).includes(a.toLowerCase()));
  if (sharedActivities.length > 0)
    reasons.push(`You both enjoy: ${sharedActivities.slice(0, 3).join(', ')}.`);

  const sharedVibe = sA.vibeWords.filter(v => lc(sB.vibeWords).includes(v.toLowerCase()));
  if (sharedVibe.length > 0)
    reasons.push(`Similar vibe — both describe themselves as ${sharedVibe.slice(0, 2).join(' and ')}.`);

  const sharedTimes = sA.availability.filter(t => lc(sB.availability).includes(t.toLowerCase()));
  if (sharedTimes.length > 0)
    reasons.push(`Overlapping availability: ${sharedTimes.slice(0, 2).join(', ')}.`);

  if (sA.meetupPreference && sA.meetupPreference === sB.meetupPreference)
    reasons.push(`You both prefer ${sA.meetupPreference.toLowerCase()} meetups.`);

  const sharedZones = sA.comfortZones.filter(z => lc(sB.comfortZones).includes(z.toLowerCase()));
  if (sharedZones.length > 0)
    reasons.push(`Shared comfort spaces: ${sharedZones.slice(0, 2).join(', ')}.`);

  const sharedPrefs = sA.preferences.filter(p => lc(sB.preferences).includes(p.toLowerCase()));
  if (sharedPrefs.length > 0)
    reasons.push(`Common interests: ${sharedPrefs.slice(0, 3).join(', ')}.`);

  if (reasons.length === 0)
    reasons.push('Profiles are in the same city with similar activity preferences.');

  return reasons.slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION STARTERS — logic + optional Groq polish
// ─────────────────────────────────────────────────────────────────────────────

function buildStarterTemplates(sA, sB) {
  const starters = [];
  const lc = (arr) => arr.map(x => x.toLowerCase());

  const sharedActs = sA.comfortActivity.filter(a => lc(sB.comfortActivity).includes(a.toLowerCase()));
  if (sharedActs.length > 0)
    starters.push(`You both enjoy ${sharedActs[0].toLowerCase()} — any favourite spot in your area lately?`);

  const sharedTimes = sA.availability.filter(t => lc(sB.availability).includes(t.toLowerCase()));
  if (sharedTimes.length > 0)
    starters.push(`You are both free during ${sharedTimes[0].toLowerCase()} — a good window for something low-key.`);

  const sharedVibes = sA.vibeWords.filter(v => lc(sB.vibeWords).includes(v.toLowerCase()));
  if (sharedVibes.length > 0)
    starters.push(`You both describe yourselves as ${sharedVibes[0].toLowerCase()} — what does that look like for you on a typical day?`);

  if (starters.length < 2 && sA.comfortActivity.length > 0)
    starters.push('What is your ideal slow weekend?');
  if (starters.length < 3)
    starters.push('What kind of meetup sounds most comfortable to you right now?');
  if (starters.length < 4)
    starters.push('You both seem to prefer calm spaces over crowds — what is your usual go-to?');

  return starters.slice(0, 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// EVOLUTION SUGGESTIONS — pattern detection, logic only
// ─────────────────────────────────────────────────────────────────────────────

function buildEvolutionSuggestions(s, user) {
  const suggestions = [];

  const lastBioUpdate = user.profileEditStats && user.profileEditStats.lastBioUpdate;
  if (lastBioUpdate && s.bio.length > 0) {
    const daysSinceBio = Math.floor((Date.now() - new Date(lastBioUpdate).getTime()) / 86400000);
    if (daysSinceBio > 30) {
      suggestions.push({
        type:   'freshness',
        title:  'Bio not updated in 30+ days',
        text:   'A quick refresh helps your profile stay current and feel active.',
        action: 'Update bio',
      });
    }
  }

  const allWords = [
    ...s.vibeWords,
    ...s.comfortActivity,
    ...s.relaxActivity,
    ...s.bio.toLowerCase().split(/\W+/).filter(w => w.length > 4),
  ].map(w => w.toLowerCase().trim()).filter(Boolean);

  const wordFreq = {};
  allWords.forEach(w => { wordFreq[w] = (wordFreq[w] || 0) + 1; });
  const topWords = Object.entries(wordFreq)
    .filter(([, c]) => c >= 3)
    .sort(([, a], [, b]) => b - a)
    .map(([w]) => w)
    .slice(0, 3);

  if (topWords.length >= 2 && s.vibeWords.length < 3) {
    suggestions.push({
      type:   'vibe_tag',
      title:  'Your profile has a consistent vibe',
      text:   `Words like "${topWords.join('", "')}" appear across your profile. Consider adding these as vibe tags.`,
      action: 'Add vibe tags',
    });
  }

  if (user.lastActive) {
    const daysInactive = Math.floor((Date.now() - new Date(user.lastActive).getTime()) / 86400000);
    if (daysInactive > 14) {
      suggestions.push({
        type:   'activity',
        title:  `Inactive for ${daysInactive} days`,
        text:   'Active profiles rank higher in discovery. Logging in regularly helps.',
        action: 'Stay active',
      });
    }
  }

  if (s.availability.length > 0 && !s.meetupPreference) {
    suggestions.push({
      type:   'preference_gap',
      title:  'Meetup preference not set',
      text:   'You have availability set but no meetup preference. Adding it helps the matching system.',
      action: 'Set meetup preference',
    });
  }

  return suggestions;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIELD TIPS / HOST TIPS (original)
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_TIP = {
  profilePhoto: 'Add a clear, well-lit profile photo — profiles with photos get 3x more views.',
  bio:          'Write a short bio (at least 10 characters) so people know who you are.',
  availability: 'Set your available time slots so people know when you can meet.',
  preferences:  'Add at least 2 interests or hangout preferences to improve your matches.',
  ageGroup:     'Set your age group for better match suggestions.',
  city:         'Add your city so nearby people can discover you.',
};

const HOST_TIP = {
  upi:         'Set up your UPI ID (Profile > Setup UPI) — without it you cannot receive earnings.',
  verification:'Get verified — the verified badge is the biggest factor in increasing booking requests.',
  hostModeOff: 'Turn ON host mode in your profile — you are currently hidden from all discovery.',
  tagline:     'Add a tagline (30 chars) — it is the first text people see on your companion card.',
};

// ─────────────────────────────────────────────────────────────────────────────
// INTENT MATCHER (original)
// ─────────────────────────────────────────────────────────────────────────────

function matchIntent(msg) {
  const l = msg.toLowerCase().trim();
  if (/^(hi|hello|hey|hii|helo|sup|what's up|whats up|namaste|yo)\b/.test(l)) return 'greeting';
  if (/\b(help|what can you do|what do you do|options|menu|assist|support)\b/.test(l) && l.length < 40) return 'help_menu';
  if (/\b(payment|upi|earn|payout|money|wallet|rupee|not receiv|not paid|setup upi|settle|withdraw|pending amount|bank|salary|income from humrah|how.*earn|earning|paid)\b/.test(l)) return 'payment_help';
  if (/\b(verif|badge|id proof|face|video verif|selfie|stuck.*verif|verif.*stuck|reject.*verif|verif.*reject|manual review|pending.*verif|attempt|trusted badge|blue tick|verify myself)\b/.test(l)) return 'verification_help';
  if (/\b(host mode|become host|activ host|companion mode|host toggle|turn.*on.*host|host.*off|hosting|host.*profile|how.*become.*companion|companion.*how|start earning)\b/.test(l)) return 'host_help';
  if (/\b(booking|bookings|not getting|no booking|why.{0,25}book|more booking|get booking|request|activity request|no request|no one book)\b/.test(l)) return 'booking_help';
  if (/\b(bio|write.*bio|better bio|bio.*help|help.*bio|about me|improve.*bio|bio.*tip|what.*write.*bio)\b/.test(l)) return 'bio_help';
  if (/\b(first|priority|most important|what.*improve|where.*start|start with|top.*issue|main.*issue|biggest.*issue)\b/.test(l)) return 'first_improve';
  if (/\b(rating|review|star|rated|feedback|hide review|report review|low rating|bad review|remove review)\b/.test(l)) return 'review_help';
  if (/\b(edit.*limit|rate limit|can.{0,10}edit|edit.*block|photo.*limit|bio.*limit|too many edit|locked|can.{0,10}change photo|how many time.*edit)\b/.test(l)) return 'edit_limit_help';
  if (/\b(complet|missing|fill|incomplete|finish|setup|set up|percent|score|how.*complete|profile.*done|done.*profile)\b/.test(l)) return 'complete_profile';
  if (/\b(improv|better|tips|help.*profile|profile.*help|enhance|update.*profile|suggestion|how.*look good|look better)\b/.test(l)) return 'improve_profile';
  if (/\b(not visible|not showing|hidden|discovery|not appear|search|show.*profile|profile.*not.*show|nobody.*find|can.{0,10}find me)\b/.test(l)) return 'visibility_help';
  if (/\b(password|change.*email|email.*change|notif|notification|setting|account setting|change.*pass|delete account|account.*delete)\b/.test(l)) return 'settings_help';
  if (/\b(bug|crash|broken|not working|error|issue|problem|report bug|app.*crash|glitch|freezing|slow)\b/.test(l)) return 'bug_help';
  if (/\b(block|report.*user|harass|unsafe|safety|suspend|ban|flag|inappropriate|report.*someone|feel unsafe|threatening)\b/.test(l)) return 'safety_help';
  if (/\b(suspend|banned|suspended|moderat|strike|warn|warning|account.*restrict|restrict.*account|flagged)\b/.test(l)) return 'moderation_help';
  if (/\b(gaming|game session|game.*room|play.*game|join.*game|create.*session|gaming.*humrah)\b/.test(l)) return 'gaming_help';
  if (/\b(movie.*session|watch.*together|movie.*humrah|movie.*room|join.*movie)\b/.test(l)) return 'movie_help';
  if (/\b(food post|food.*share|food.*photo|food.*discover|food.*humrah|post.*food)\b/.test(l)) return 'food_help';
  if (/\b(delete.*account|remove.*account|deactivate|close.*account)\b/.test(l)) return 'delete_account_help';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIC ENGINE (original — preserved exactly)
// ─────────────────────────────────────────────────────────────────────────────

function runLogicEngine(intent, s) {
  const { missingFields, completionScore, hasProfilePhoto, bio, preferences, availability,
    isHost, hasUpi, upiStatus, isVerified, verificationStatus, verificationType,
    verificationAttempts, lastRejectionReason, hostActive, hostMissing, hasTagline,
    pendingPayout, totalEarnings, completedPayouts, averageRating, totalRatings,
    completedBookings, emailVerified, userType, accountStatus, canEditPhoto,
    strikeCount, isModerationFlagged, daysSinceLastActive } = s;

  switch (intent) {
    case 'greeting': return { intro: 'Hey! I am your Humrah Profile Assistant.', bullets: ['I can help you improve your profile, fix issues, and understand app features.', 'Try asking: "How do I get more bookings?" or tap an option below.'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'help_menu': return { intro: 'Here is what I can help you with:', bullets: ['Profile tips — improve bio, photo, preferences, availability.', 'Payments — UPI setup, payout schedule, earnings.', 'Verification — how to get verified and fix rejections.', 'Host mode — become an Activity Host and get bookings.', 'Safety & settings — block users, change email/password, delete account.'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'complete_profile': {
      if (missingFields.length === 0) {
        const extra = [];
        if (isHost && !hasUpi)     extra.push('Set up your UPI ID to start receiving earnings.');
        if (isHost && !isVerified) extra.push('Get verified — it significantly increases booking requests.');
        if (!emailVerified)        extra.push('Verify your email address for full account access.');
        return { intro: `Your profile is ${completionScore}% complete — all key fields are done!`, bullets: ['Refresh your bio every few weeks to stay relevant.', 'Keep your availability updated to attract more connections.', ...extra].slice(0, 5), callToAction: null, completionScore, showOptionsAfter: true };
      }
      return { intro: `Your profile is ${completionScore}% complete. Here is what is missing:`, bullets: missingFields.slice(0, 5).map(f => FIELD_TIP[f] || `Fill in your ${f}.`), callToAction: 'Fix Now', completionScore, showOptionsAfter: false };
    }
    case 'improve_profile': {
      const tips = [];
      tips.push(!hasProfilePhoto ? 'Add a real, well-lit photo — profiles with photos get 3x more views.' : bio.length < 10 ? 'Write a 2-3 sentence bio. Share what you enjoy and what kind of meetup you are open to.' : `Your bio is ${bio.length} chars. Keep it authentic.`);
      tips.push(availability.length === 0 ? 'Set your availability so people know when you are free to meet.' : 'Availability is set — update it whenever your schedule changes.');
      tips.push(preferences.length < 2 ? 'Add at least 2 interests to boost your discovery ranking.' : `You have ${preferences.length} interests. Keep them current.`);
      if (isHost && !hasUpi)     tips.push('As a host, set up your UPI ID to receive earnings from completed bookings.');
      if (isHost && !isVerified) tips.push('Get verified — the badge builds trust and increases booking requests.');
      if (!emailVerified)        tips.push('Verify your email address for full account security.');
      return { intro: 'Personalised tips for your profile:', bullets: tips.slice(0, 5), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }
    case 'booking_help': {
      if (accountStatus !== 'ACTIVE') return { intro: 'Your account is currently restricted.', bullets: [`Status: ${accountStatus}. Contact support to resolve this.`], callToAction: null, completionScore, showOptionsAfter: true };
      const reasons = [];
      if (!hasProfilePhoto)        reasons.push('No profile photo — the top reason people skip a profile.');
      if (bio.length < 10)         reasons.push('Missing or very short bio.');
      if (availability.length === 0)reasons.push('No availability set.');
      if (preferences.length < 2)  reasons.push('Too few interests.');
      if (isHost && !hostActive)   reasons.push('Host mode is OFF — turn it ON to appear in discovery.');
      if (isHost && !isVerified)   reasons.push('Not verified — a verified badge significantly increases requests.');
      if (isHost && !hasUpi)       reasons.push('No UPI set up — required for paid bookings.');
      if (isHost && !hasTagline)   reasons.push('No host tagline — add one (30 chars).');
      if (!s.city)                 reasons.push('City not set — people nearby cannot discover you.');
      if (reasons.length === 0) {
        const activeTips = ['Log in daily — active profiles rank higher.', 'Update your availability often.', 'Refresh your bio every few weeks.'];
        if (totalRatings === 0) activeTips.push('No reviews yet — complete your first booking to build reputation.');
        return { intro: 'Your profile looks great! Tips to attract more bookings:', bullets: activeTips.slice(0, 5), callToAction: null, completionScore, showOptionsAfter: true };
      }
      return { intro: `${reasons.length} thing(s) holding back your bookings:`, bullets: reasons.slice(0, 5), callToAction: 'Fix Issues', completionScore, showOptionsAfter: false };
    }
    case 'payment_help': {
      if (!isHost) return { intro: 'Earnings are only available for Activity Hosts.', bullets: ['MEMBER accounts do not earn.', 'To become a host: Profile > Edit Profile > Activity Host Mode.'], callToAction: null, completionScore, showOptionsAfter: true };
      if (!hasUpi || upiStatus === 'not_set') return { intro: 'You have not set up a UPI ID yet.', bullets: ['Go to: Profile > Setup UPI.', 'Valid formats: name@ybl, 9876543210@paytm, name@oksbi.', 'UPI must be verified before any payout is released.'], callToAction: 'Setup UPI', completionScore, showOptionsAfter: false };
      if (upiStatus === 'pending_verification') return { intro: 'UPI saved but not yet verified.', bullets: ['Open Setup UPI > tap "Verify UPI" to complete.'], callToAction: 'Setup UPI', completionScore, showOptionsAfter: false };
      if (upiStatus === 'failed') return { intro: 'UPI verification failed.', bullets: ['Go to Profile > Setup UPI and re-enter your UPI ID.'], callToAction: 'Setup UPI', completionScore, showOptionsAfter: false };
      const nextPayout = pendingPayout >= 500 ? 'You will be paid automatically this Monday.' : `Earnings below 500 are paid on the 1st of next month (pending: ${pendingPayout}).`;
      return { intro: 'Your UPI is verified.', bullets: [nextPayout, `Total earned: ${totalEarnings}. Payouts completed: ${completedPayouts}.`], callToAction: null, completionScore, showOptionsAfter: true };
    }
    case 'verification_help': {
      const tips = [];
      if (isVerified) { tips.push(`You are verified via ${verificationType || 'photo/video'}.`); tips.push('The verified badge boosts your discovery ranking significantly.'); }
      else if (verificationStatus === 'pending') { tips.push('Verification submitted and under review. Wait up to 48 hours.'); }
      else if (verificationStatus === 'rejected') { tips.push('Verification was rejected.'); if (lastRejectionReason) tips.push(`Reason: ${lastRejectionReason}`); tips.push('To resubmit: Profile > tap the unverified badge > record a new video.'); }
      else if (['manual_review', 'manual review'].includes(verificationStatus)) { tips.push('In manual review — up to 72 hours. You will be notified.'); }
      else { tips.push('Not verified yet. To verify: Profile > tap the unverified badge > record a short video.'); tips.push('Make sure your profile photo is a clear, well-lit, recent photo of your face.'); }
      return { intro: null, bullets: tips, callToAction: isVerified ? null : 'Get Verified', completionScore, showOptionsAfter: isVerified };
    }
    case 'host_help': {
      if (!isHost) return { intro: 'You are not an Activity Host yet.', bullets: ['To become a host: Profile > Edit Profile > questionnaire > Activity Host Mode.', 'Set up your UPI ID so you can receive earnings.', 'Get verified — the verified badge is the top factor in getting booking requests.'], callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
      const hostTips = [];
      if (!hostActive)   hostTips.push('Host mode is OFF — turn it ON to appear in discovery.');
      if (!isVerified)   hostTips.push('Get verified — tap the unverified badge to start.');
      if (!hasUpi)       hostTips.push('Set up your UPI ID to receive earnings.');
      if (!hasTagline)   hostTips.push('Add a host tagline (30 chars max).');
      if (hostTips.length === 0) { hostTips.push('Host profile is fully set up!'); if (totalRatings > 0) hostTips.push(`Your rating: ${averageRating} from ${totalRatings} review(s).`); else hostTips.push('No reviews yet — focus on your first booking!'); }
      return { intro: 'Activity Host status:', bullets: hostTips.slice(0, 5), callToAction: null, completionScore, showOptionsAfter: false };
    }
    case 'bio_help': {
      const tips = [];
      if (bio.length === 0) { tips.push('No bio yet — this is the second most important field after your photo.'); tips.push('Start with who you are and what you enjoy.'); }
      else if (bio.length < 30) { tips.push(`Bio is very short (${bio.length} chars). Aim for 50-100 characters.`); }
      else { tips.push(`Bio is ${bio.length} characters — solid! Keep it genuine.`); }
      tips.push('Keep under 150 characters. No phone numbers, social handles, or links.');
      return { intro: 'Bio tips:', bullets: tips.slice(0, 5), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }
    case 'first_improve': {
      const priority   = ['profilePhoto', 'bio', 'availability', 'preferences', 'ageGroup', 'city'];
      const topMissing = priority.filter(f => missingFields.includes(f));
      const hostPriority = isHost ? hostMissing : [];
      if (topMissing.length === 0 && hostPriority.length === 0) return { intro: 'Profile is complete! Stay active to rank higher:', bullets: ['Update your availability weekly.', 'Refresh your bio monthly.'], callToAction: null, completionScore, showOptionsAfter: true };
      const top = topMissing[0];
      if (top) return { intro: `Start here: ${top}`, bullets: [FIELD_TIP[top], topMissing[1] ? FIELD_TIP[topMissing[1]] : null, hostPriority[0] ? HOST_TIP[hostPriority[0]] : null].filter(Boolean), callToAction: 'Fix Now', completionScore, showOptionsAfter: false };
      return { intro: `Start here: ${hostPriority[0]}`, bullets: [HOST_TIP[hostPriority[0]]].filter(Boolean), callToAction: 'Edit Profile', completionScore, showOptionsAfter: false };
    }
    case 'review_help': return { intro: null, bullets: [totalRatings === 0 ? 'No reviews yet — they appear after completed bookings.' : `Rating: ${averageRating} from ${totalRatings} review(s).`, 'You can HIDE (not delete) a review — tap the three dots on the review.', 'To report a fake review: tap the three dots > Report Review.'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'edit_limit_help': return { intro: 'Profile edit limits:', bullets: ['Profile photo: 1 change per day.', 'Bio: 5 changes per day.', 'Age group: 1 change per month.', 'State / area: 2 changes per month.'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'visibility_help': {
      const issues = [];
      if (!hasProfilePhoto)           issues.push('No profile photo.');
      if (!s.city)                    issues.push('City not set.');
      if (isHost && !hostActive)      issues.push('Host mode is OFF.');
      if (accountStatus !== 'ACTIVE') issues.push(`Account status: ${accountStatus}.`);
      if (missingFields.length > 2)   issues.push(`Profile is only ${completionScore}% complete.`);
      if (daysSinceLastActive > 14)   issues.push(`Inactive for ${daysSinceLastActive} days.`);
      if (issues.length === 0) return { intro: 'Visibility settings look fine. Tips to improve ranking:', bullets: ['Log in daily.', 'Update your availability.', 'Get verified.'], callToAction: null, completionScore, showOptionsAfter: true };
      return { intro: 'Reasons your profile may not be visible:', bullets: issues.slice(0, 5), callToAction: 'Fix Issues', completionScore, showOptionsAfter: false };
    }
    case 'settings_help': return { intro: 'Common account settings:', bullets: ['Change email: Settings > Account > Change Email (OTP required).', 'Change password: Settings > Account > Change Password (min 8 chars).', 'Notifications: Settings > Notifications.', 'Delete account: Settings > scroll to bottom > Delete Account (permanent).'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'bug_help': return { intro: 'Sorry something is not working!', bullets: ['Report it: Help & Support > Report a Bug.', 'For urgent issues (account access, payment), use Contact Support.', 'Try force-closing and reopening the app first.'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'safety_help': return { intro: 'Staying safe on Humrah:', bullets: ['Always meet in PUBLIC places.', 'Block someone: tap dots on their profile > Block.', 'Report someone: tap the flag icon on their profile card.'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'moderation_help': {
      if (accountStatus === 'BANNED') return { intro: 'Your account has been permanently banned.', bullets: ['Contact support via Help & Support > Contact Support.'], callToAction: null, completionScore, showOptionsAfter: false };
      if (accountStatus === 'SUSPENDED') return { intro: 'Your account is currently suspended.', bullets: ['Check your email for suspension details.', 'Do not create a new account while suspended.', 'Contact support for clarification.'], callToAction: null, completionScore, showOptionsAfter: false };
      const bullets = [strikeCount > 0 ? `You have ${strikeCount} moderation strike(s). 3 strikes = suspension.` : 'Your account is in good standing.', 'Common violations: sharing contact info in bio, inappropriate language, harassment.'];
      return { intro: null, bullets, callToAction: null, completionScore, showOptionsAfter: true };
    }
    case 'gaming_help': return { intro: 'Gaming sessions on Humrah:', bullets: ['Create: Gaming tab > Create Session > pick game type, max players, start time.', 'Join: browse open sessions in the Gaming tab.', 'Chat room stays open for 3 hours after session start.', '2-hour cooldown between creating sessions.'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'movie_help': return { intro: 'Movie sessions on Humrah:', bullets: ['Create: Movie tab > Create Session > pick a trending movie + a nearby theatre.', 'Others in your area can join and chat.'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'food_help': return { intro: 'Food posts on Humrah:', bullets: ['Share: Food tab > New Post > photo + caption (120 chars) + place + price range.', 'Posts expire after 48 hours.', 'Feed shows posts from people within 15 km.'], callToAction: null, completionScore, showOptionsAfter: true };
    case 'delete_account_help': return { intro: 'How to delete your account:', bullets: ['Go to: Settings > scroll to the very bottom > Delete Account.', 'PERMANENT and cannot be undone.', 'If you have a pending payout, contact support BEFORE deleting.'], callToAction: null, completionScore, showOptionsAfter: false };
    default: return { intro: null, bullets: [], callToAction: null, completionScore, showOptionsAfter: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ HELPERS (original — preserved)
// ─────────────────────────────────────────────────────────────────────────────

async function polishBullets(bullets) {
  const key = process.env.GROQ_API_KEY;
  if (!key || bullets.length === 0) return bullets;
  const numbered = bullets.map((b, i) => `${i + 1}. ${b}`).join('\n');
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'Rewrite a numbered list of profile tips for a social companion app. Keep each tip warm, short, and actionable. One sentence max. Return ONLY the same numbered list.' },
        { role: 'user', content: `Rewrite:\n${numbered}` },
      ],
      max_tokens: 400, temperature: 0.4,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 7000 });
    const raw = res.data?.choices?.[0]?.message?.content?.trim() || '';
    if (!raw) return bullets;
    const lines = raw.split('\n').map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
    if (lines.length !== bullets.length) return bullets;
    return lines.map((l, i) => (l.length > 0 && l.length < 250 ? l : bullets[i]));
  } catch { return bullets; }
}

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
    `Verified: ${summary.isVerified} (status: ${summary.verificationStatus})`,
    `Rating: ${summary.averageRating} from ${summary.totalRatings} reviews`,
    `Account status: ${summary.accountStatus}`,
    `Moderation strikes: ${summary.strikeCount}`,
  ].join('\n');
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: HUMRAH_KNOWLEDGE_BASE },
        { role: 'user', content: `User profile (anonymised):\n${filteredData}\n\nQuestion: ${userMessage}\n\nAnswer in 3-5 lines, specific and actionable.` },
      ],
      max_tokens: 250, temperature: 0.55,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 9000 });
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
  if (fixable.length === 0) return { success: true, message: 'Your profile data is already complete — no AI fixes needed!', applied: [] };
  const q = user.questionnaire || {};
  const ctxLines = [
    Array.isArray(q.hangoutPreferences) && q.hangoutPreferences.length ? `Hangout style: ${q.hangoutPreferences.join(', ')}` : null,
    Array.isArray(q.interests) && q.interests.length ? `Interests: ${q.interests.join(', ')}` : null,
    Array.isArray(q.vibeWords) && q.vibeWords.length ? `Vibe: ${q.vibeWords.join(', ')}` : null,
    Array.isArray(q.comfortActivity) && q.comfortActivity.length ? `Comfort activities: ${q.comfortActivity.join(', ')}` : null,
    Array.isArray(q.relaxActivity) && q.relaxActivity.length ? `Relax activities: ${q.relaxActivity.join(', ')}` : null,
    q.mood ? `Mood: ${q.mood}` : null,
    q.personalityType ? `Personality: ${q.personalityType}` : null,
    q.ageGroup ? `Age group: ${q.ageGroup}` : null,
    q.meetupPreference ? `Meetup pref: ${q.meetupPreference}` : null,
  ].filter(Boolean).join('\n');
  const fieldInstructions = fixable.map(f => {
    if (f === 'bio') return 'bio: a warm, genuine 2-3 sentence bio for a social companion app in India. Max 140 chars. No emojis. No phone numbers. No social handles.';
    if (f === 'preferences') return 'interests: exactly 3 relevant interest strings as a JSON array.';
    if (f === 'availability') return 'availableTimes: 2-3 realistic time slot strings as a JSON array.';
    return null;
  }).filter(Boolean);
  const prompt = `Fill in missing profile fields for a user on Humrah, an Indian social companion app.\n\nUser context:\n${ctxLines || 'No context — use friendly defaults.'}\n\nGenerate ONLY:\n${fieldInstructions.join('\n')}\n\nReturn ONLY valid JSON with keys: ${fixable.join(', ')}. No markdown, no extra text.`;
  let generated;
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'Return only valid JSON. No markdown. No explanation.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 350, temperature: 0.65,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 15000 });
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
  if (applied.length === 0) return { success: false, message: 'AI could not generate valid values. Please fill the fields manually.' };
  user.markModified('questionnaire');
  await user.save();
  const newSummary = buildSafeProfileSummary(user);
  return { success: true, message: `AI updated ${applied.length} field(s) on your profile!`, applied, newCompletionScore: newSummary.completionScore };
}

// ─────────────────────────────────────────────────────────────────────────────
// BIO REWRITE — Groq with tone
// ─────────────────────────────────────────────────────────────────────────────

const TONE_PROMPTS = {
  calm:       'Write a calm, peaceful, unhurried bio. Soft language. No excitement markers.',
  warm:       'Write a warm, friendly, approachable bio. Inviting but not overly cheerful.',
  funny:      'Write a gently humorous bio. Self-aware, dry wit. Not cringe or forced.',
  introvert:  'Write a bio that feels safe for an introvert — honest, low-pressure, no hype.',
  elegant:    'Write an elegant, refined bio. Thoughtful phrasing, understated.',
  thoughtful: 'Write a thoughtful, reflective bio. Values depth over surface impressions.',
  casual:     'Write a casual, relaxed bio. Simple language, natural.',
};

async function rewriteBio(rawText, tone, summary) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { success: false, message: 'Bio assistant requires GROQ_API_KEY.' };

  const toneInstruction = TONE_PROMPTS[tone] || TONE_PROMPTS['calm'];
  const contextHints = [
    summary.comfortActivity.length > 0 ? `Activities: ${summary.comfortActivity.slice(0, 3).join(', ')}` : null,
    summary.vibeWords.length > 0 ? `Vibe: ${summary.vibeWords.slice(0, 3).join(', ')}` : null,
    summary.mood ? `Mood: ${summary.mood}` : null,
    summary.meetupPreference ? `Meetup style: ${summary.meetupPreference}` : null,
  ].filter(Boolean).join('. ');

  const prompt = `Rewrite this rough bio for a social companion app in India called Humrah. People use Humrah to meet others for calm, public activities — coffee, walks, films, gaming.\n\n${toneInstruction}\n\nUser's rough thoughts: "${rawText}"\n${contextHints ? `Context: ${contextHints}` : ''}\n\nRules:\n- Max 140 characters\n- No emojis\n- No phone numbers, social handles, or URLs\n- Sound human, not like a dating app\n- Do not use clichés like "love to laugh" or "foodie"\n- Return ONLY the bio text. No quotes, no explanation.`;

  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'Return only the bio text. No quotes. No explanation. Max 140 characters.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 100, temperature: 0.7,
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 10000 });
    let bio = (res.data?.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
    bio = bio.slice(0, 140);
    if (!bio || bio.length < 5) return { success: false, message: 'Could not generate a bio. Please try again.' };
    const safe = scanBioSafety(bio);
    if (!safe.safe) return { success: false, message: 'Generated bio contained disallowed content. Please try again.' };
    return { success: true, bio };
  } catch (err) {
    console.error('[Assistant] bio rewrite error:', err?.response?.data || err.message);
    return { success: false, message: 'Bio assistant is unavailable right now. Try again in a moment.' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — ORIGINAL (consent, analyze, chat, ai-fix)
// ─────────────────────────────────────────────────────────────────────────────

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
      return res.status(400).json({ success: false, code: 'INVALID_INTENT', message: "I didn't understand that. Please select one of the options.", showOptions: true });
    }
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    const summary = buildSafeProfileSummary(user);
    const result  = runLogicEngine(intent, summary);
    const bullets = result.bullets.length > 0 && process.env.GROQ_API_KEY ? await polishBullets(result.bullets) : result.bullets;
    return res.json({ success: true, source: 'logic', intent, completionScore: result.completionScore, intro: result.intro, bullets, callToAction: result.callToAction, showOptionsAfter: result.showOptionsAfter });
  } catch (err) {
    console.error('[Assistant] analyze:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/chat', assistantLimiter, auth, async (req, res) => {
  try {
    const { message, groqCallCount = 0 } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, code: 'EMPTY_MESSAGE', message: "I didn't catch that. Try asking something or use the quick options.", showOptions: true });
    const trimmed = message.trim();
    if (trimmed.length > 500) return res.status(400).json({ success: false, code: 'MESSAGE_TOO_LONG', message: 'Please keep your message under 500 characters.', showOptions: false });
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    const summary = buildSafeProfileSummary(user);
    const matched = matchIntent(trimmed);
    if (matched) {
      const result  = runLogicEngine(matched, summary);
      const bullets = result.bullets.length > 0 && process.env.GROQ_API_KEY ? await polishBullets(result.bullets) : result.bullets;
      return res.json({ success: true, source: 'logic', intent: matched, completionScore: result.completionScore, intro: result.intro, bullets, callToAction: result.callToAction, showOptionsAfter: result.showOptionsAfter || groqCallCount >= 2 });
    }
    if (await overGroqLimit(user)) return res.json({ success: true, source: 'limit', intro: "You have reached today's AI assist limit.", bullets: ['Your daily AI limit resets at midnight.', 'Try one of the quick options below.'], callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore });
    if (!process.env.GROQ_API_KEY) return res.json({ success: true, source: 'fallback', intro: "I didn't fully understand that. Try one of these options:", bullets: [], callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore });
    incrementGroq(user);
    let groqReply = null;
    try { groqReply = await groqFallback(trimmed, summary); } catch {}
    if (!groqReply) return res.json({ success: true, source: 'fallback', intro: "I didn't fully understand that. Try one of these options:", bullets: [], callToAction: null, showOptionsAfter: true, completionScore: summary.completionScore });
    const newCount = groqCallCount + 1;
    return res.json({ success: true, source: 'groq', groqReply, groqCallCount: newCount, showOptionsAfter: newCount >= 2, completionScore: summary.completionScore });
  } catch (err) {
    console.error('[Assistant] chat:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/ai-fix', assistantLimiter, auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    if (await overGroqLimit(user)) return res.status(429).json({ success: false, code: 'DAILY_LIMIT', message: "You've reached today's AI assist limit. Try again tomorrow or fill fields manually." });
    incrementGroq(user);
    const summary = buildSafeProfileSummary(user);
    const result  = await generateAndApplyAiFix(user, summary);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('[Assistant] ai-fix:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — NEW (health, nudges, bio, trust, match, starters, evolution)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/profile-assistant/health
router.get('/health', assistantLimiter, auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    const summary = buildSafeProfileSummary(user);
    const scores  = buildHealthScores(summary);
    return res.json({ success: true, scores, completionScore: summary.completionScore });
  } catch (err) {
    console.error('[Assistant] health:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/profile-assistant/nudges
router.get('/nudges', assistantLimiter, auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    const summary = buildSafeProfileSummary(user);
    const nudges  = buildNudges(summary);
    return res.json({ success: true, nudges, completionScore: summary.completionScore });
  } catch (err) {
    console.error('[Assistant] nudges:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/profile-assistant/bio
// body: { rawText: String, tone: String }
router.post('/bio', assistantLimiter, auth, async (req, res) => {
  try {
    const { rawText, tone = 'calm' } = req.body;
    if (!rawText || !rawText.trim()) return res.status(400).json({ success: false, message: 'Please provide some rough thoughts to rewrite.' });
    if (rawText.trim().length > 300) return res.status(400).json({ success: false, message: 'Input too long — keep it under 300 characters.' });
    const VALID_TONES = ['calm', 'warm', 'funny', 'introvert', 'elegant', 'thoughtful', 'casual'];
    const safeTone = VALID_TONES.includes(tone) ? tone : 'calm';
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    if (await overGroqLimit(user)) return res.status(429).json({ success: false, code: 'DAILY_LIMIT', message: "You've reached today's AI assist limit. Try again tomorrow." });
    incrementGroq(user);
    const summary = buildSafeProfileSummary(user);
    const result  = await rewriteBio(rawText.trim(), safeTone, summary);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('[Assistant] bio:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/profile-assistant/trust
router.get('/trust', assistantLimiter, auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    const summary = buildSafeProfileSummary(user);
    const signals = buildTrustSignals(summary);
    const scores  = buildHealthScores(summary);
    return res.json({ success: true, signals, trustScore: scores.trust, completionScore: summary.completionScore });
  } catch (err) {
    console.error('[Assistant] trust:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/profile-assistant/match/:userId
router.get('/match/:userId', assistantLimiter, auth, async (req, res) => {
  try {
    const [userA, userB] = await Promise.all([
      User.findById(req.userId),
      User.findById(req.params.userId),
    ]);
    if (!userA || !userB) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!userA.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    const sA = buildSafeProfileSummary(userA);
    const sB = buildSafeProfileSummary(userB);
    const reasons = buildMatchExplanation(sA, sB);
    return res.json({ success: true, reasons });
  } catch (err) {
    console.error('[Assistant] match:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/profile-assistant/starters/:userId
router.get('/starters/:userId', assistantLimiter, auth, async (req, res) => {
  try {
    const [userA, userB] = await Promise.all([
      User.findById(req.userId),
      User.findById(req.params.userId),
    ]);
    if (!userA || !userB) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!userA.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    const sA = buildSafeProfileSummary(userA);
    const sB = buildSafeProfileSummary(userB);
    const starters = buildStarterTemplates(sA, sB);
    return res.json({ success: true, starters });
  } catch (err) {
    console.error('[Assistant] starters:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/profile-assistant/evolution
router.get('/evolution', assistantLimiter, auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.profileBotConsent) return res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    const summary     = buildSafeProfileSummary(user);
    const suggestions = buildEvolutionSuggestions(summary, user);
    return res.json({ success: true, suggestions, completionScore: summary.completionScore });
  } catch (err) {
    console.error('[Assistant] evolution:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
