// routes/profileAssistant.js
// ─────────────────────────────────────────────────────────────────────────────
// Profile Assistant v2 — redesigned with health scores, nudges, bio AI,
// match explanation, conversation starters, trust signals, evolution.
//
// Original endpoints (preserved):
//   POST /consent   → store profileBotConsent = true
//   POST /analyze   → deterministic answer for a known intent
//   POST /chat      → conversational turn: facts from the profile, AI phrasing,
//                     follow-up history; deterministic answer when AI is down
//   POST /ai-fix    → RETIRED (410): it saved AI-invented profile data unreviewed
//
// New endpoints:
//   GET  /health           → completeness, bio, interests, verification, missing items
//   GET  /nudges           → personalised suggestions (title, reason, action, priority)
//   POST /bio              → AI bio draft from the user's notes + tone (never saved here)
//   GET  /trust            → user's own trust signals
//   GET  /match/:userId    → overlap explanation for a match
//   GET  /starters/:userId → conversation starters for a user pair
//   GET  /evolution        → tracked progress, recent edits, real milestones
//
// Facts come from services/profileAssistant/assistantFacts.js; the only model
// calls are in services/profileAssistant/assistantAi.js.
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

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const mongoose = require('mongoose');
const { auth } = require('../middleware/auth');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const User     = require('../models/User');
const Booking  = require('../models/Booking');
const VerificationSession = require('../models/VerificationSession');
const ProfileEditLog = require('../models/ProfileEditLog');
const { calculateProfileCompletion } = require('../utils/profileCompletion');
const { moderateQuestionnaireSync } = require('../middleware/moderation');
const assistantFacts = require('../services/profileAssistant/assistantFacts');
const ai       = require('../services/profileAssistant/assistantAi');
const { getOrCreateBaseline } = require('../services/profileAssistant/progressStore');

// ─────────────────────────────────────────────────────────────────────────────
// BIO CACHE  — inline schema, TTL 7 days
// ─────────────────────────────────────────────────────────────────────────────

const bioCacheSchema = new mongoose.Schema({
  promptHash: { type: String, required: true, unique: true },
  bio:        { type: String, required: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt:  { type: Date, default: Date.now, expires: 604800 }, // 7 days TTL
});
// Note: unique: true on promptHash already creates the index — no schema.index() needed

const BioCache = mongoose.models.BioCache || mongoose.model('BioCache', bioCacheSchema);

function bioCacheKey(userId, rawText, tone) {
  return crypto.createHash('sha256').update(`${userId}|${rawText}|${tone}`).digest('hex');
}

async function getBioFromCache(hash) {
  try {
    const entry = await BioCache.findOne({ promptHash: hash });
    return entry ? entry.bio : null;
  } catch { return null; }
}

async function storeBioInCache(hash, bio, userId) {
  try {
    await BioCache.findOneAndUpdate(
      { promptHash: hash },
      { promptHash: hash, bio, userId, createdAt: new Date() },
      { upsert: true, new: true },
    );
  } catch (_) { /* cache write failure is non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITER
// ─────────────────────────────────────────────────────────────────────────────

// BUGFIX: `keyGenerator: ipKeyGenerator` handed the request object to a helper
// that expects an IP string, so every request got a key of its own and the limit
// never applied. Every route here runs after `authenticate`, so key by account;
// the IP (via the helper, as intended) is only a fallback.
const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? `user:${req.userId}` : ipKeyGenerator(req.ip || '')),
  handler: (_req, res) => res.status(429).json({
    success: false, code: 'RATE_LIMITED',
    message: 'Slow down — wait a moment and try again.',
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

// Groq model. Kept in step with services/providers/groqProvider.js, which already
// uses openai/gpt-oss-120b — this file was still pinned to llama-3.1-8b-instant,
// so the two AI paths in the product ran on different models. Env-overridable so
// a model change never again needs a code deploy.
const GROQ_MODEL       = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// Daily AI calls per user (chat replies + bio drafts). 5 made a real conversation
// impossible — a few follow-up questions used the whole day. Still env-overridable.
const GROQ_DAILY_LIMIT = Number(process.env.GROQ_DAILY_LIMIT) > 0
  ? Number(process.env.GROQ_DAILY_LIMIT)
  : 30;

const getTodayStr = () => new Date().toISOString().slice(0, 10);

function groqCallsToday(user) {
  const e = user.groqUsage;
  if (!e || e.date !== getTodayStr()) return 0;
  return e.count || 0;
}

/**
 * Consumes one daily AI credit and returns the resulting count.
 *
 * BUGFIX: this used to compute the next value in JS and fire the write off
 * without awaiting it (`User.updateOne(...).catch(() => {})`). Two concurrent
 * requests both read the same count and both wrote count+1, so the daily cap was
 * trivially exceeded — and any write error was swallowed, which silently granted
 * unlimited paid AI calls. Now a single atomic update: `$inc` when the stored day
 * is still today, otherwise `$set` to start a new day.
 */
async function incrementGroq(user) {
  const today = getTodayStr();
  try {
    if (user.groqUsage && user.groqUsage.date === today) {
      const updated = await User.findOneAndUpdate(
        { _id: user._id, 'groqUsage.date': today },
        { $inc: { 'groqUsage.count': 1 } },
        { new: true, projection: { groqUsage: 1 } }
      );
      if (updated) {
        user.groqUsage = updated.groqUsage;
        return updated.groqUsage.count;
      }
    }
    // First call of the day (or the stored day has rolled over).
    const reset = await User.findOneAndUpdate(
      { _id: user._id },
      { $set: { groqUsage: { date: today, count: 1 } } },
      { new: true, projection: { groqUsage: 1 } }
    );
    user.groqUsage = reset ? reset.groqUsage : { date: today, count: 1 };
    return user.groqUsage.count;
  } catch (err) {
    // Fail CLOSED: if usage cannot be recorded we must not hand out a free call.
    console.error('[Assistant] groq usage increment failed:', err.message);
    throw err;
  }
}

function overGroqLimit(user) {
  return groqCallsToday(user) >= GROQ_DAILY_LIMIT;
}

/**
 * Gives back the credit of a call that produced nothing (timeout, provider error,
 * unusable output), so a provider outage does not use up the user's day. Only
 * today's counter, and never below zero.
 */
async function refundGroq(user) {
  const today = getTodayStr();
  try {
    const updated = await User.findOneAndUpdate(
      { _id: user._id, 'groqUsage.date': today, 'groqUsage.count': { $gt: 0 } },
      { $inc: { 'groqUsage.count': -1 } },
      { new: true, projection: { groqUsage: 1 } }
    );
    if (updated) user.groqUsage = updated.groqUsage;
  } catch (err) {
    // Not refunding only costs the user one credit; the request itself is already answered.
    console.error('[Assistant] groq usage refund failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST CONTEXT — the facts every assistant answer is built from
// ─────────────────────────────────────────────────────────────────────────────

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Host booking counts for this user only. */
async function loadBookingStats(userId) {
  const since = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - NINETY_DAYS_MS) / 1000));
  const [byStatus, last90Days] = await Promise.all([
    Booking.aggregate([
      { $match: { companionId: new mongoose.Types.ObjectId(String(userId)) } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    Booking.countDocuments({ companionId: userId, _id: { $gte: since } }),
  ]);
  const stats = { pending: 0, confirmed: 0, completed: 0, cancelled: 0, last90Days };
  for (const row of byStatus) if (row._id in stats) stats[row._id] = row.n;
  return stats;
}

/**
 * Builds the deterministic facts for `user`. Booking counts are loaded only for
 * hosts. A failure to read them is reported as "not available" rather than
 * guessed — the answer then says Humrah cannot see the numbers.
 */
async function loadFacts(user) {
  const latestVerificationSession = await VerificationSession.findOne({ userId: user._id })
    .sort({ createdAt: -1 })
    .select('status rejectionReason createdAt reviewedAt')
    .lean();
  let bookingStats = null;
  const q = user.questionnaire || {};
  if (user.userType === 'COMPANION' || q.becomeCompanion === "Yes, I'm interested") {
    try {
      bookingStats = await loadBookingStats(user._id);
    } catch (err) {
      console.error('[Assistant] booking stats unavailable:', err.message);
    }
  }
  const f = assistantFacts.buildFacts(user, { latestVerificationSession, bookingStats });
  const suggestions = assistantFacts.buildSuggestions(f);
  return { facts: f, suggestions };
}

async function loadConsentedUser(req, res) {
  const user = await User.findById(req.userId);
  if (!user) { res.status(404).json({ success: false, message: 'User not found.' }); return null; }
  if (!user.profileBotConsent) {
    res.status(403).json({ success: false, code: 'CONSENT_REQUIRED', message: 'We need your permission to access your profile data.' });
    return null;
  }
  return user;
}

// How each AI failure kind is answered. Messages are for people, not logs.
const AI_FAILURE = {
  not_configured: { status: 503, code: 'AI_NOT_CONFIGURED', retryable: false,
    message: "The AI assistant isn't available right now." },
  timeout:        { status: 504, code: 'AI_TIMEOUT', retryable: true,
    message: 'That took too long. Please try again.' },
  rate_limited:   { status: 503, code: 'AI_BUSY', retryable: true,
    message: 'The assistant is busy right now. Please try again in a minute.' },
  provider_error: { status: 503, code: 'AI_UNAVAILABLE', retryable: true,
    message: "I couldn't reach the assistant just now. Please try again." },
  bad_output:     { status: 502, code: 'AI_BAD_OUTPUT', retryable: true,
    message: "I couldn't put together a good answer that time. Please try again." },
};

function aiFailure(kind) { return AI_FAILURE[kind] || AI_FAILURE.provider_error; }


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
  // BUGFIX: this was a SECOND completion formula — "(6 - missing) / 6" over six
  // hand-picked fields — so the assistant told the user a different percentage
  // from the one the Profile screen showed for the same account. The canonical
  // item-based calculator is the single source of truth for that number.
  // `missingFields` below stays the assistant's own short coaching list, which is
  // a different thing: what to nudge the user about next, not what the score is.
  const completionScore = calculateProfileCompletion(user).percentage;

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

  // Same source of truth as profile completion and discovery (photo verification
  // approved), not the separate `verified` flag.
  const isVerified           = user.photoVerificationStatus === 'approved';
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
// FIELD TIPS / HOST TIPS
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
// INTENT MATCHER
// ─────────────────────────────────────────────────────────────────────────────

// BUGFIX: every pattern is wrapped in \b…\b, so word stems like "verif", "complet"
// and "improv" never matched "verified", "Complete" or "improve" — a typed "How do
// I get verified?" fell through to the generic reply. Stems now take `\w*`.
function matchIntent(msg) {
  const l = msg.toLowerCase().trim();
  if (/\b(payment|upi|earn|payout|money|wallet|rupee|not receiv\w*|not paid|setup upi|settle|withdraw|pending amount|bank|salary|income from humrah|how.*earn|earning|paid)\b/.test(l)) return 'payment_help';
  if (/\b(verif\w*|badge|id proof|face|video verif|selfie|stuck.*verif|verif.*stuck|reject.*verif|verif.*reject|manual review|pending.*verif|attempt|trusted badge|blue tick|verify myself)\b/.test(l)) return 'verification_help';
  if (/\b(host mode|become host|activ host|companion mode|host toggle|turn.*on.*host|host.*off|hosting|host.*profile|how.*become.*companion|companion.*how|start earning)\b/.test(l)) return 'host_help';
  if (/\b(booking|bookings|not getting|no booking|why.{0,25}book|more booking|get booking|request|activity request|no request|no one book)\b/.test(l)) return 'booking_help';
  if (/\b(bio|write.*bio|better bio|bio.*help|help.*bio|about me|improve.*bio|bio.*tip|what.*write.*bio)\b/.test(l)) return 'bio_help';
  if (/\b(first|priority|most important|what.*improve|where.*start|start with|top.*issue|main.*issue|biggest.*issue)\b/.test(l)) return 'first_improve';
  if (/\b(rating|review|star|rated|feedback|hide review|report review|low rating|bad review|remove review)\b/.test(l)) return 'review_help';
  if (/\b(edit.*limit|rate limit|can.{0,10}edit|edit.*block|photo.*limit|bio.*limit|too many edit|locked|can.{0,10}change photo|how many time.*edit)\b/.test(l)) return 'edit_limit_help';
  if (/\b(complet\w*|missing|fill|incomplete|finish|setup|set up|percent|score|how.*complete|profile.*done|done.*profile)\b/.test(l)) return 'complete_profile';
  if (/\b(improv\w*|better|tips|help.*profile|profile.*help|enhance|update.*profile|suggestion|how.*look good|look better)\b/.test(l)) return 'improve_profile';
  if (/\b(not visible|not showing|hidden|discovery|not appear|search|show.*profile|profile.*not.*show|nobody.*find|can.{0,10}find me)\b/.test(l)) return 'visibility_help';
  if (/\b(password|change.*email|email.*change|notif|notification|setting|account setting|change.*pass|delete account|account.*delete)\b/.test(l)) return 'settings_help';
  if (/\b(bug|crash|broken|not working|error|issue|problem|report bug|app.*crash|glitch|freezing|slow)\b/.test(l)) return 'bug_help';
  if (/\b(block|report.*user|harass|unsafe|safety|suspend|ban|flag|inappropriate|report.*someone|feel unsafe|threatening)\b/.test(l)) return 'safety_help';
  if (/\b(suspend|banned|suspended|moderat\w*|strike|warn|warning|account.*restrict|restrict.*account|flagged)\b/.test(l)) return 'moderation_help';
  if (/\b(gaming|game session|game.*room|play.*game|join.*game|create.*session|gaming.*humrah)\b/.test(l)) return 'gaming_help';
  if (/\b(movie.*session|watch.*together|movie.*humrah|movie.*room|join.*movie)\b/.test(l)) return 'movie_help';
  if (/\b(food post|food.*share|food.*photo|food.*discover|food.*humrah|post.*food)\b/.test(l)) return 'food_help';
  if (/\b(delete.*account|remove.*account|deactivate|close.*account)\b/.test(l)) return 'delete_account_help';
  // Generic openers last, so "help me write a better bio" or "hi, why no bookings?"
  // reach the specific answer instead of the menu.
  if (/^(hi|hello|hey|hii|helo|sup|what's up|whats up|namaste|yo)\b/.test(l)) return 'greeting';
  if (/\b(help|what can you do|what do you do|options|menu|assist|support)\b/.test(l) && l.length < 40) return 'help_menu';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIC ENGINE
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
      if (!hasProfilePhoto)         reasons.push('No profile photo — the top reason people skip a profile.');
      if (bio.length < 10)          reasons.push('Missing or very short bio.');
      if (availability.length === 0)reasons.push('No availability set.');
      if (preferences.length < 2)   reasons.push('Too few interests.');
      if (isHost && !hostActive)    reasons.push('Host mode is OFF — turn it ON to appear in discovery.');
      if (isHost && !isVerified)    reasons.push('Not verified — a verified badge significantly increases requests.');
      if (isHost && !hasUpi)        reasons.push('No UPI set up — required for paid bookings.');
      if (isHost && !hasTagline)    reasons.push('No host tagline — add one (30 chars).');
      if (!s.city)                  reasons.push('City not set — people nearby cannot discover you.');
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
// ROUTES — ORIGINAL (consent, analyze, chat, ai-fix)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/consent', assistantLimiter, async (req, res) => {
  try {
    console.log(`[Assistant] POST /consent userId=${req.userId}`);
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

// Intents the deterministic guidance answers directly; everything else in
// VALID_INTENTS still uses the original logic engine.
const GUIDED_INTENTS = new Set([
  'improve_profile', 'first_improve', 'bio_help', 'complete_profile', 'verification_help', 'booking_help',
]);

const VALID_INTENTS = [
  'improve_profile', 'booking_help', 'complete_profile',
  'bio_help', 'first_improve', 'payment_help',
  'verification_help', 'host_help', 'settings_help',
  'bug_help', 'safety_help', 'review_help', 'edit_limit_help',
  'visibility_help', 'moderation_help', 'gaming_help',
  'movie_help', 'food_help', 'delete_account_help',
  'greeting', 'help_menu',
];

/** Deterministic answer for an intent: { intro, bullets, actions, callToAction }. */
function answerForIntent(intent, f, suggestions, user) {
  if (GUIDED_INTENTS.has(intent)) {
    const g = assistantFacts.buildGuidance(intent, f, suggestions);
    return { ...g, callToAction: g.actions[0] ? g.actions[0].label : null, showOptionsAfter: g.actions.length === 0 };
  }
  const legacy = runLogicEngine(intent, buildSafeProfileSummary(user));
  return { intro: legacy.intro, bullets: legacy.bullets, actions: [], callToAction: null, showOptionsAfter: true };
}

router.post('/analyze', assistantLimiter, async (req, res) => {
  try {
    const { intent } = req.body || {};
    if (!intent || !VALID_INTENTS.includes(intent)) {
      return res.status(400).json({ success: false, code: 'INVALID_INTENT', message: "I didn't understand that. Please select one of the options.", showOptions: true });
    }
    const user = await loadConsentedUser(req, res);
    if (!user) return;
    const { facts: f, suggestions } = await loadFacts(user);
    const a = answerForIntent(intent, f, suggestions, user);
    return res.json({
      success: true, source: 'logic', intent,
      completionScore: f.completion.percentage,
      intro: a.intro, bullets: a.bullets, callToAction: a.callToAction, actions: a.actions,
      showOptionsAfter: a.showOptionsAfter,
    });
  } catch (err) {
    console.error('[Assistant] analyze:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * POST /chat — one conversational turn.
 *
 * Body: { message, history?: [{role:'user'|'assistant', text}], intent? }
 *   `history` is the visible conversation so far (the app keeps it for the
 *   session; nothing is stored server-side). `intent` is sent by the quick-prompt
 *   chips so they run through this same path as typed messages.
 *
 * Every reply is grounded in facts computed from the user's profile. When the AI
 * is available it phrases the answer and handles follow-ups; when it is not, a
 * recognised question still gets the deterministic answer, and anything else gets
 * a clear, retryable error — never a canned reply dressed up as AI.
 *
 * Response keeps the original fields (source, groqReply, intro, bullets,
 * callToAction, showOptionsAfter, completionScore, groqCallCount) for older app
 * versions, and adds: reply, answerSource ('ai'|'logic'), draftBio, actions, notice.
 */
router.post('/chat', assistantLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const { message, history, groqCallCount = 0 } = body;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, code: 'EMPTY_MESSAGE', message: "I didn't catch that. Try asking something or use the quick options.", showOptions: true });
    }
    const trimmed = message.trim();
    if (trimmed.length > 500) {
      return res.status(400).json({ success: false, code: 'MESSAGE_TOO_LONG', message: 'Please keep your message under 500 characters.', showOptions: false });
    }
    if (history !== undefined && !Array.isArray(history)) {
      return res.status(400).json({ success: false, code: 'INVALID_HISTORY', message: 'Conversation history must be a list.' });
    }
    const requestedIntent = typeof body.intent === 'string' && VALID_INTENTS.includes(body.intent) ? body.intent : null;

    const user = await loadConsentedUser(req, res);
    if (!user) return;

    const { facts: f, suggestions } = await loadFacts(user);
    const intent = requestedIntent || matchIntent(trimmed);
    const logic = intent ? answerForIntent(intent, f, suggestions, user) : null;
    const completionScore = f.completion.percentage;
    const count = Number(groqCallCount) || 0;

    const logicResponse = (notice) => res.json({
      success: true, source: 'logic', answerSource: 'logic', intent,
      reply: logic.intro || '', intro: logic.intro, bullets: logic.bullets,
      callToAction: logic.callToAction, actions: logic.actions, draftBio: null,
      notice: notice || null, showOptionsAfter: logic.showOptionsAfter, completionScore,
    });

    if (!ai.isConfigured()) {
      if (logic) return logicResponse(null);
      const fail = aiFailure('not_configured');
      return res.status(fail.status).json({ success: false, code: fail.code, retryable: fail.retryable,
        message: "I can only answer the quick questions right now. Try one of the options below.", showOptions: true });
    }

    if (overGroqLimit(user)) {
      if (logic) return logicResponse("You've used today's AI replies, so this answer comes straight from your profile.");
      return res.status(429).json({ success: false, code: 'DAILY_LIMIT', retryable: false,
        message: "You've used today's AI replies. They reset daily at 5:30 AM IST. The quick options below still work.", showOptions: true });
    }

    await incrementGroq(user);
    const result = await ai.chatReply({
      message: trimmed,
      history: Array.isArray(history) ? history : [],
      context: assistantFacts.buildAiContext(f),
      guidance: logic,
    });

    if (!result.ok) {
      await refundGroq(user);
      if (logic) return logicResponse("I couldn't reach the AI just now, so here's what your profile shows.");
      const fail = aiFailure(result.kind);
      return res.status(fail.status).json({ success: false, code: fail.code, retryable: fail.retryable, message: fail.message });
    }

    const actions = logic ? [...logic.actions] : [];
    if (result.draftBio && !actions.some(a => a.target === assistantFacts.TARGET.BIO_ASSISTANT)) {
      actions.push({ label: 'Edit in Bio Assistant', target: assistantFacts.TARGET.BIO_ASSISTANT });
    }
    const newCount = count + 1;
    return res.json({
      success: true, source: 'groq', answerSource: 'ai', intent,
      reply: result.reply, groqReply: result.reply, draftBio: result.draftBio,
      actions, notice: null, groqCallCount: newCount,
      showOptionsAfter: newCount >= 2, completionScore,
    });
  } catch (err) {
    console.error('[Assistant] chat:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * POST /ai-fix — RETIRED.
 *
 * This used to have the model invent missing bio text, interests and availability
 * ("friendly defaults" when the profile had no context) and save them straight to
 * the profile without the user seeing them first. That puts made-up information on
 * a real person's profile, so it no longer writes anything. The route stays so
 * older app versions get a clear answer instead of a 404; current versions do not
 * call it. Bios now go through POST /bio and are saved only by the user.
 */
router.post('/ai-fix', assistantLimiter, async (req, res) => {
  return res.status(410).json({
    success: false, code: 'AI_FIX_RETIRED',
    message: "The assistant no longer edits your profile automatically. Use the Bio Assistant to draft a bio you can review, or update your profile yourself.",
    applied: [],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — NEW (health, nudges, bio, trust, match, starters, evolution)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /health — what the profile actually contains, kept as separate concepts:
 * completeness (defined, canonical), bio length, interests, verification state,
 * trust steps and missing items marked required/optional. `scores` and
 * `completionScore` are unchanged for older app versions.
 */
router.get('/health', assistantLimiter, async (req, res) => {
  try {
    const user = await loadConsentedUser(req, res);
    if (!user) return;
    const { facts: f, suggestions } = await loadFacts(user);
    const scores = buildHealthScores(buildSafeProfileSummary(user));
    return res.json({
      success: true, scores, completionScore: f.completion.percentage,
      health: assistantFacts.buildHealth(f, suggestions),
    });
  } catch (err) {
    console.error('[Assistant] health:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * GET /nudges — personalised suggestions. Each item: id, title, text, reason,
 * action, actionTarget, priority (high|medium|low), plus the original level/field
 * for older app versions. Rebuilt from the profile on every call, so a fixed item
 * disappears on the next load.
 */
router.get('/nudges', assistantLimiter, async (req, res) => {
  try {
    const user = await loadConsentedUser(req, res);
    if (!user) return;
    const { facts: f, suggestions } = await loadFacts(user);
    return res.json({ success: true, nudges: suggestions, completionScore: f.completion.percentage, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[Assistant] nudges:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

const BIO_INPUT_MAX = 300;

/**
 * POST /bio — draft a bio from the user's own rough notes. Never saves it: the app
 * shows the draft for review and editing, and the user saves through the normal
 * profile editor endpoint.
 *
 * Body: { rawText, tone, regenerate?: boolean, previousBio?: string }
 *   regenerate=true skips the cache and asks for a different version of previousBio.
 */
router.post('/bio', assistantLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const rawText = typeof body.rawText === 'string' ? body.rawText.trim() : '';
    const tone = body.tone === undefined ? 'calm' : body.tone;
    const regenerate = body.regenerate === true;
    const previousBio = typeof body.previousBio === 'string' ? body.previousBio.trim().slice(0, 200) : null;

    if (!rawText) return res.status(400).json({ success: false, code: 'EMPTY_INPUT', message: 'Write a few words about yourself first.' });
    if (rawText.length > BIO_INPUT_MAX) return res.status(400).json({ success: false, code: 'INPUT_TOO_LONG', message: `Please keep your notes under ${BIO_INPUT_MAX} characters.` });
    if (typeof tone !== 'string' || !Object.prototype.hasOwnProperty.call(ai.TONES, tone)) {
      return res.status(400).json({ success: false, code: 'INVALID_TONE', message: 'Please choose one of the listed tones.' });
    }

    const user = await loadConsentedUser(req, res);
    if (!user) return;

    if (!ai.isConfigured()) {
      const fail = aiFailure('not_configured');
      return res.status(fail.status).json({ success: false, code: fail.code, retryable: fail.retryable,
        message: "The Bio Assistant isn't available right now. You can still write or edit your bio yourself." });
    }

    const hash = bioCacheKey(req.userId, rawText, tone);
    if (!regenerate) {
      const cached = await getBioFromCache(hash);
      if (cached) return res.json({ success: true, bio: cached, tone, cached: true, maxLength: assistantFacts.BIO_MAX });
    }

    if (overGroqLimit(user)) {
      return res.status(429).json({ success: false, code: 'DAILY_LIMIT', retryable: false,
        message: "You've used today's AI drafts. They reset daily at 5:30 AM IST — you can still edit your bio yourself." });
    }
    await incrementGroq(user);

    const result = await ai.generateBio({ rawText, tone, previousBio: regenerate ? previousBio : null });
    if (!result.ok) {
      await refundGroq(user);
      const fail = aiFailure(result.kind);
      return res.status(fail.status).json({ success: false, code: fail.code, retryable: fail.retryable, message: fail.message });
    }

    // Same synchronous moderation every questionnaire write uses. A draft that
    // trips it is not shown; the user can simply try again.
    const { cleanedQuestionnaire, errors } = moderateQuestionnaireSync({ bio: result.bio });
    const safeBio = cleanedQuestionnaire && typeof cleanedQuestionnaire.bio === 'string' ? cleanedQuestionnaire.bio.trim() : '';
    if ((errors && errors.length > 0) || safeBio !== result.bio) {
      await refundGroq(user);
      console.warn('[Assistant] bio draft rejected by moderation; not returned.');
      const fail = aiFailure('bad_output');
      return res.status(fail.status).json({ success: false, code: fail.code, retryable: true, message: fail.message });
    }

    await storeBioInCache(hash, safeBio, user._id);
    return res.json({ success: true, bio: safeBio, tone, cached: false, maxLength: assistantFacts.BIO_MAX });
  } catch (err) {
    console.error('[Assistant] bio:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/trust', assistantLimiter, async (req, res) => {
  try {
    const user = await loadConsentedUser(req, res);
    if (!user) return;
    const summary = buildSafeProfileSummary(user);
    const signals = buildTrustSignals(summary);
    const scores  = buildHealthScores(summary);
    return res.json({ success: true, signals, trustScore: scores.trust, completionScore: summary.completionScore });
  } catch (err) {
    console.error('[Assistant] trust:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/match/:userId', assistantLimiter, async (req, res) => {
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

router.get('/starters/:userId', assistantLimiter, async (req, res) => {
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

const EVOLUTION_EDIT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * GET /evolution — real progress only.
 *
 * - baseline: where the profile stood the first time the user opened Evolution
 *   (recorded then, never back-filled), compared with now;
 * - completedSinceBaseline: items missing at the baseline that are filled in now;
 * - recentEdits: field names and dates from ProfileEditLog (no values);
 * - milestones: dates Humrah already stores (joined, verification).
 * Nothing is estimated. `suggestions` is unchanged for older app versions.
 */
router.get('/evolution', assistantLimiter, async (req, res) => {
  try {
    const user = await loadConsentedUser(req, res);
    if (!user) return;
    const { facts: f } = await loadFacts(user);
    const missingKeys = f.completion.missing.map(m => m.key);

    let tracking;
    try {
      const base = await getOrCreateBaseline(user._id, { percentage: f.completion.percentage, missingKeys });
      const completedSinceBaseline = base.baselineMissing
        .filter(k => !missingKeys.includes(k))
        .map(k => ({ key: k, label: assistantFacts.itemInfo(k).label }));
      tracking = {
        available: true,
        startedAt: base.baselineAt,
        startedNow: base.created,
        baselinePercentage: base.baselinePercentage,
        currentPercentage: f.completion.percentage,
        completedSinceBaseline,
      };
    } catch (err) {
      console.error('[Assistant] evolution baseline unavailable:', err.message);
      tracking = { available: false, currentPercentage: f.completion.percentage, completedSinceBaseline: [] };
    }

    const edits = await ProfileEditLog.find({ userId: user._id, editedAt: { $gte: new Date(Date.now() - EVOLUTION_EDIT_WINDOW_MS) } })
      .sort({ editedAt: -1 })
      .limit(30)
      .select('field editedAt')
      .lean();
    const seen = new Set();
    const recentEdits = [];
    for (const e of edits) {
      const day = new Date(e.editedAt).toISOString().slice(0, 10);
      const k = `${e.field}|${day}`;
      if (seen.has(k)) continue;
      seen.add(k);
      recentEdits.push({ field: e.field, label: assistantFacts.itemInfo(e.field).label, editedAt: e.editedAt });
      if (recentEdits.length >= 10) break;
    }

    const milestones = [];
    if (user.createdAt) milestones.push({ type: 'joined', label: 'Joined Humrah', date: user.createdAt });
    if (f.verification.status === 'pending' && f.verification.submittedAt) {
      milestones.push({ type: 'verification_submitted', label: 'Sent photo verification', date: f.verification.submittedAt });
    }
    if (f.verification.status === 'approved' && user.photoVerifiedAt) {
      milestones.push({ type: 'verified', label: 'Photo verified', date: user.photoVerifiedAt });
    }
    milestones.sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.json({
      success: true,
      suggestions: buildEvolutionSuggestions(buildSafeProfileSummary(user), user),
      completionScore: f.completion.percentage,
      evolution: {
        tracking,
        recentEdits,
        milestones,
        note: 'Progress is tracked from the first time you opened the Profile Assistant. Humrah does not have a record of earlier changes.',
      },
    });
  } catch (err) {
    console.error('[Assistant] evolution:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
module.exports._internals = { answerForIntent, matchIntent, GUIDED_INTENTS, VALID_INTENTS, GROQ_DAILY_LIMIT, assistantLimiter };
