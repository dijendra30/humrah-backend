// services/profileAssistant/assistantFacts.js
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic facts behind the Profile Assistant.
//
// Everything objective — what is missing, how long the bio is, the verification
// state, whether a host can appear in discovery, booking counts — is computed
// here from the real user record. The language model never decides any of it;
// it only phrases answers around these facts (see assistantAi.js).
//
// Pure functions only: no database, no network. The route loads the user, the
// latest verification session and booking counts, then passes them in.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const {
  calculateProfileCompletion,
  HOST_INTERESTED_ANSWER,
} = require('../../utils/profileCompletion');

// Where the Android app edits each item. The client maps these keys to existing
// screens; an unknown key falls back to the profile screen.
const TARGET = Object.freeze({
  PROFILE:           'profile',            // Profile screen (photo, basics, host toggle)
  PROFILE_QUESTIONS: 'profile_questions',  // Profile questionnaire (bio, hangout, quote, host mode)
  MORE_ABOUT_YOU:    'more_about_you',     // Optional "Getting to Know You" questions
  VERIFICATION:      'verification',       // Photo verification flow
  BIO_ASSISTANT:     'bio_assistant',      // Bio Assistant sheet inside the assistant
  HOST_SETTINGS:     'host_settings',      // Profile screen, host section
  UPI_SETUP:         'upi_setup',          // Profile > Setup UPI
  SUPPORT:           'support',            // Help & Support
});

// One entry per canonical completion item (utils/profileCompletion.js keys).
// `optional` marks questions the app itself presents as optional extras: missing
// them does not make a profile poor, and the UI says so.
const ITEM_INFO = Object.freeze({
  dateOfBirth:           { label: 'Date of birth',                      target: TARGET.PROFILE,           optional: false },
  city:                  { label: 'City',                               target: TARGET.PROFILE,           optional: false },
  preferredLanguages:    { label: 'Languages you speak',                target: TARGET.PROFILE,           optional: false },
  gender:                { label: 'Gender',                             target: TARGET.PROFILE,           optional: false },
  availableTimes:        { label: "When you're usually free",           target: TARGET.PROFILE,           optional: false },
  vibeWords:             { label: 'Vibe words',                         target: TARGET.PROFILE,           optional: false },
  conversationInterests: { label: 'Things you like talking about',      target: TARGET.PROFILE,           optional: false },
  humrahRoomInterests:   { label: 'Room topics you like',               target: TARGET.PROFILE,           optional: true  },
  movieGenre:            { label: 'Favourite movie genre',              target: TARGET.PROFILE,           optional: false },
  favoriteFood:          { label: 'Favourite food',                     target: TARGET.PROFILE,           optional: false },
  hobbies:               { label: 'Hobbies',                            target: TARGET.PROFILE,           optional: false },
  travelPreference:      { label: 'How you like exploring',             target: TARGET.MORE_ABOUT_YOU,    optional: true  },
  socialVibe:            { label: 'Your social vibe',                   target: TARGET.MORE_ABOUT_YOU,    optional: true  },
  comfortZones:          { label: "Places you're comfortable meeting",  target: TARGET.MORE_ABOUT_YOU,    optional: true  },
  budgetComfort:         { label: 'Budget comfort',                     target: TARGET.MORE_ABOUT_YOU,    optional: true  },
  hangoutFrequency:      { label: 'How often you like to hang out',     target: TARGET.MORE_ABOUT_YOU,    optional: true  },
  comfortActivity:       { label: 'Comfort activities',                 target: TARGET.MORE_ABOUT_YOU,    optional: true  },
  relaxActivity:         { label: 'How you relax',                      target: TARGET.MORE_ABOUT_YOU,    optional: true  },
  musicPreference:       { label: 'Music you like',                     target: TARGET.MORE_ABOUT_YOU,    optional: true  },
  bio:                   { label: 'Bio',                                target: TARGET.BIO_ASSISTANT,     optional: false },
  goodMeetupMeaning:     { label: 'What makes a hangout great for you', target: TARGET.PROFILE_QUESTIONS, optional: false },
  vibeQuote:             { label: 'A quote or motto',                   target: TARGET.PROFILE_QUESTIONS, optional: true  },
  becomeCompanion:       { label: 'Activity Host Mode answer',          target: TARGET.PROFILE_QUESTIONS, optional: false },
  openFor:               { label: 'Activities you host',                target: TARGET.PROFILE_QUESTIONS, optional: false },
  availability:          { label: 'Hosting availability',               target: TARGET.PROFILE_QUESTIONS, optional: false },
  costSharingPreference: { label: 'Cost-sharing preference',            target: TARGET.PROFILE_QUESTIONS, optional: false },
  tagline:               { label: 'Host tagline',                       target: TARGET.PROFILE_QUESTIONS, optional: false },
  profilePhoto:          { label: 'Profile photo',                      target: TARGET.PROFILE,           optional: false },
  photoVerification:     { label: 'Photo verification',                 target: TARGET.VERIFICATION,      optional: false },
});

// Same limits the app's profile editor enforces (ProfileQuestionsData.kt maxLength
// 150; PUT /users/me/questionnaire requires 20–150 characters).
const BIO_MIN_SAVE = 20;
const BIO_MAX = 150;
const BIO_GOOD = 60;

const UNSAFE_BIO_PATTERNS = [
  /\d{10}/,
  /https?:\/\//i,
  /@[a-z0-9_.]+/i,
  /\bescort\b/i,
  /\bpaid comp(any|anion)\b/i,
  /\bprivate\s+(meetup|meet|visit)\b/i,
  /\bagency\b/i,
];

function isBioSafe(bio) {
  return !UNSAFE_BIO_PATTERNS.some(p => p.test(bio || ''));
}

function humanizeKey(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

function itemInfo(key) {
  return ITEM_INFO[key] || { label: humanizeKey(key), target: TARGET.PROFILE, optional: false };
}

const asArray = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);
const asText  = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function dedupeCaseInsensitive(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = item.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(item); }
  }
  return out;
}

// ── Bio ─────────────────────────────────────────────────────────────────────

function assessBio(bioRaw) {
  const bio = asText(bioRaw) || '';
  const length = bio.length;
  if (length === 0) {
    return { status: 'missing', length, message: "You don't have a bio yet." };
  }
  if (!isBioSafe(bio)) {
    return { status: 'needs_attention', length,
      message: 'Your bio seems to include contact details, a link or wording Humrah does not allow.' };
  }
  if (length < BIO_MIN_SAVE) {
    return { status: 'too_short', length, message: `Your bio is ${length} characters — a sentence or two more gives people something to reply to.` };
  }
  if (length < BIO_GOOD) {
    return { status: 'short', length, message: `Your bio is ${length} characters. It works; a little more detail can make it easier to start a conversation.` };
  }
  return { status: 'good_length', length, message: `Your bio is ${length} of ${BIO_MAX} characters.` };
}

// ── Verification ────────────────────────────────────────────────────────────
//
// The real flow (routes/verification.js): the user records a short selfie video
// following 3–4 on-screen prompts, it is uploaded, and the Humrah team reviews it
// manually. Approval sets photoVerificationStatus = 'approved'. A rejection only
// updates the VerificationSession (the user record stays 'pending'), so the latest
// session is read to report a rejection truthfully.

function verificationState(user, latestSession) {
  const userStatus = user.photoVerificationStatus || 'not_submitted';
  const session = latestSession || null;
  const sessionStatus = session && session.status;

  if (userStatus === 'approved') {
    return { status: 'approved', label: 'Verified',
      message: 'Your photo is verified.',
      verifiedAt: user.photoVerifiedAt || null };
  }
  if (sessionStatus === 'REJECTED' || userStatus === 'rejected') {
    const reason = (session && session.rejectionReason) || user.photoRejectionReason || null;
    return { status: 'rejected', label: 'Not approved',
      message: reason
        ? `Your last verification was not approved. Reason given: ${reason}. You can record a new video.`
        : 'Your last verification was not approved. You can record a new video.',
      rejectionReason: reason };
  }
  if (userStatus === 'pending' || sessionStatus === 'MANUAL_REVIEW') {
    return { status: 'pending', label: 'Under review',
      message: 'Your verification video was received and is waiting for manual review by the Humrah team. You do not need to do anything else right now.',
      submittedAt: user.verificationPhotoSubmittedAt || (session && session.createdAt) || null };
  }
  return { status: 'not_started', label: 'Not verified',
    message: 'Your photo is not verified yet. Verification is a short selfie video (about 6 seconds) where you follow a few on-screen prompts; the Humrah team then reviews it.' };
}

// ── Facts ───────────────────────────────────────────────────────────────────

/**
 * @param {object} user               Mongoose User document or plain object
 * @param {object} [extra]
 * @param {object} [extra.latestVerificationSession]  newest VerificationSession (lean)
 * @param {object} [extra.bookingStats]               { pending, confirmed, completed, cancelled, last90Days } as host
 */
function buildFacts(user, extra = {}) {
  const q = (user.questionnaire && typeof user.questionnaire.toObject === 'function')
    ? user.questionnaire.toObject()
    : (user.questionnaire || {});

  const completion = calculateProfileCompletion(user);
  const missing = completion.missingFields.map(m => {
    const info = itemInfo(m.key);
    return { key: m.key, label: info.label, optional: info.optional, target: info.target };
  });

  const interests = dedupeCaseInsensitive([
    ...asArray(q.hobbies),
    ...asArray(q.conversationInterests),
    ...asArray(q.interests),
  ]);

  const isHost = user.userType === 'COMPANION' || q.becomeCompanion === HOST_INTERESTED_ANSWER;
  const city = asText(user.liveLocation && user.liveLocation.city) || asText(q.city);
  const verification = verificationState(user, extra.latestVerificationSession);

  const host = isHost ? {
    isHost: true,
    hostModeOn: user.userType === 'COMPANION',
    hostingPaused: user.hostActive === false,
    hasTagline: !!asText(q.tagline),
    openFor: asArray(q.openFor),
    availability: asText(q.availability),
    costSharingPreference: asText(q.costSharingPreference),
    hasUpi: !!(user.paymentInfo && user.paymentInfo.upiId),
    // The conditions GET /api/spotlight applies (controllers/spotlight.controller.js),
    // plus the optional "verified only" filter members can switch on.
    discoveryChecks: [
      { key: 'host_mode',     ok: user.userType === 'COMPANION', label: 'Activity Host Mode is on in your profile questions' },
      { key: 'hosting_on',    ok: user.hostActive !== false,     label: 'Hosting is switched on (not paused)' },
      { key: 'account_active',ok: (user.status || 'ACTIVE') === 'ACTIVE', label: 'Your account is active' },
      { key: 'profile_photo', ok: !!user.profilePhoto,           label: 'You have a profile photo (Spotlight only lists hosts with one)' },
      { key: 'city',          ok: !!city,                        label: 'Your city is set (Spotlight shows hosts in the member\'s city)' },
      { key: 'verified',      ok: verification.status === 'approved', label: 'Your photo is verified (members can filter to verified hosts only)' },
    ],
  } : { isHost: false };

  const ratings = user.ratingStats || {};

  return {
    completion: {
      percentage: completion.percentage,
      completed: completion.completed,
      applicable: completion.applicable,
      missing,
    },
    bio: { text: asText(q.bio), ...assessBio(q.bio) },
    interests: { items: interests, count: interests.length },
    verification,
    host,
    bookings: isHost && extra.bookingStats ? { available: true, ...extra.bookingStats } : { available: false },
    ratings: { average: Number(ratings.averageRating) || 0, count: Number(ratings.totalRatings) || 0 },
    hasPhoto: !!user.profilePhoto,
    hasCity: !!city,
    accountStatus: user.status || 'ACTIVE',
    emailVerified: user.emailVerified === true,
    profile: {
      vibeWords: asArray(q.vibeWords),
      availableTimes: asArray(q.availableTimes),
      comfortActivity: asArray(q.comfortActivity),
      relaxActivity: asArray(q.relaxActivity),
      musicPreference: asArray(q.musicPreference),
      comfortZones: asArray(q.comfortZones),
      hangoutPreferences: asArray(q.hangoutPreferences),
      meetupPreference: asText(q.meetupPreference),
      socialVibe: asText(q.socialVibe),
      personalityType: asText(q.personalityType),
      goodMeetupMeaning: asText(q.goodMeetupMeaning),
      vibeQuote: asText(q.vibeQuote),
    },
  };
}

// ── Suggestions ─────────────────────────────────────────────────────────────

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const LEGACY_LEVEL  = { high: 'critical', medium: 'warn', low: 'info' };

function suggestion(s) {
  // `level`, `field`, `text`, `action` keep the shape older app versions render.
  return { ...s, level: LEGACY_LEVEL[s.priority], field: s.field || s.id };
}

function isMissing(facts, key) {
  return facts.completion.missing.some(m => m.key === key);
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/**
 * Personalised, actionable recommendations from the user's current data. Each
 * one disappears as soon as the underlying data is fixed, because the list is
 * rebuilt from the profile on every request — nothing is "marked done" early.
 */
function buildSuggestions(facts) {
  const out = [];

  if (facts.accountStatus !== 'ACTIVE') {
    out.push(suggestion({ id: 'account_status', priority: 'high',
      title: 'Your account is restricted',
      text: 'While your account is restricted, parts of Humrah are unavailable.',
      reason: `Your account status is ${facts.accountStatus}.`,
      action: 'Contact support', actionTarget: TARGET.SUPPORT }));
  }

  if (!facts.hasPhoto) {
    out.push(suggestion({ id: 'add_photo', field: 'profilePhoto', priority: 'high',
      title: 'Add a profile photo',
      text: 'A clear, recent photo of you helps people recognise who they are meeting.',
      reason: "Your profile doesn't have a photo yet.",
      action: 'Add photo', actionTarget: TARGET.PROFILE }));
  }

  const b = facts.bio;
  if (b.status === 'missing') {
    out.push(suggestion({ id: 'write_bio', field: 'bio', priority: 'high',
      title: 'Write a short bio',
      text: 'A sentence or two about what you enjoy gives people an easy way to start a conversation.',
      reason: "You don't have a bio yet.",
      action: 'Write with Bio Assistant', actionTarget: TARGET.BIO_ASSISTANT }));
  } else if (b.status === 'needs_attention') {
    out.push(suggestion({ id: 'fix_bio', field: 'bioSafety', priority: 'high',
      title: 'Remove contact details from your bio',
      text: 'Phone numbers, links and social handles are not allowed in bios and can lead to moderation.',
      reason: b.message,
      action: 'Edit bio', actionTarget: TARGET.PROFILE_QUESTIONS }));
  } else if (b.status === 'too_short' || b.status === 'short') {
    out.push(suggestion({ id: 'expand_bio', field: 'bio', priority: b.status === 'too_short' ? 'high' : 'medium',
      title: 'Say a little more in your bio',
      text: 'Mention one or two things you enjoy or the kind of plans you like. It does not need to be long.',
      reason: b.message,
      action: 'Improve with Bio Assistant', actionTarget: TARGET.BIO_ASSISTANT }));
  }

  if (facts.interests.count < 2) {
    out.push(suggestion({ id: 'add_interests', field: 'preferences', priority: 'medium',
      title: 'Add a few interests',
      text: 'Shared interests are often how conversations start. Pick ones you genuinely enjoy.',
      reason: facts.interests.count === 0
        ? "You haven't listed any hobbies or interests yet."
        : `You've listed ${plural(facts.interests.count, 'interest', 'interests')} (${facts.interests.items.slice(0, 3).join(', ')}).`,
      action: 'Update interests', actionTarget: TARGET.PROFILE }));
  }

  if (isMissing(facts, 'availableTimes')) {
    out.push(suggestion({ id: 'add_availability', field: 'availability', priority: 'medium',
      title: "Say when you're usually free",
      text: 'Even "weekends" helps people suggest a time that suits you.',
      reason: "You haven't said when you're usually free.",
      action: 'Set availability', actionTarget: TARGET.PROFILE }));
  }

  const v = facts.verification;
  if (v.status === 'not_started') {
    out.push(suggestion({ id: 'verify_photo', field: 'verification', priority: 'medium',
      title: 'Verify your photo',
      text: 'Record a short selfie video following a few prompts. The Humrah team reviews it, and approved profiles show a verified badge.',
      reason: 'Your photo is not verified yet.',
      action: 'Start verification', actionTarget: TARGET.VERIFICATION }));
  } else if (v.status === 'rejected') {
    out.push(suggestion({ id: 'retry_verification', field: 'verification', priority: 'medium',
      title: 'Try photo verification again',
      text: 'Make sure your face is clearly visible and well lit, then follow each on-screen prompt.',
      reason: v.message,
      action: 'Record a new video', actionTarget: TARGET.VERIFICATION }));
  }

  if (facts.host.isHost) {
    const h = facts.host;
    if (h.hostingPaused) {
      out.push(suggestion({ id: 'resume_hosting', field: 'hostModeOff', priority: 'high',
        title: 'Hosting is paused',
        text: 'While hosting is paused you are not listed for activity bookings. Switch it back on from your profile when you are ready.',
        reason: 'Your hosting status is set to paused.',
        action: 'Open host settings', actionTarget: TARGET.HOST_SETTINGS }));
    }
    const hostGaps = ['openFor', 'availability', 'costSharingPreference', 'tagline']
      .filter(k => isMissing(facts, k))
      .map(k => itemInfo(k).label.toLowerCase());
    if (hostGaps.length > 0) {
      out.push(suggestion({ id: 'finish_host_details', field: 'hostDetails', priority: 'medium',
        title: 'Finish your host details',
        text: 'Members decide whether to book from these details, so it helps to fill them in.',
        reason: `Missing: ${hostGaps.join(', ')}.`,
        action: 'Edit host details', actionTarget: TARGET.PROFILE_QUESTIONS }));
    }
    if (!h.hasUpi) {
      out.push(suggestion({ id: 'setup_upi', field: 'upi', priority: 'medium',
        title: 'Set up UPI for payouts',
        text: 'Hosts need a UPI ID on file to receive earnings from completed bookings.',
        reason: "You're a host without a UPI ID set up.",
        action: 'Set up UPI', actionTarget: TARGET.UPI_SETUP }));
    }
  }

  const profileGaps = ['goodMeetupMeaning', 'becomeCompanion'].filter(k => isMissing(facts, k));
  if (profileGaps.length > 0) {
    out.push(suggestion({ id: 'profile_questions', field: 'profileQuestions', priority: 'low',
      title: 'Answer your profile questions',
      text: 'These short answers tell people what kind of plans you enjoy.',
      reason: `Unanswered: ${profileGaps.map(k => itemInfo(k).label.toLowerCase()).join(', ')}.`,
      action: 'Answer questions', actionTarget: TARGET.PROFILE_QUESTIONS }));
  }

  const optionalMissing = facts.completion.missing.filter(m => m.optional && m.target === TARGET.MORE_ABOUT_YOU);
  if (optionalMissing.length > 0) {
    out.push(suggestion({ id: 'optional_questions', field: 'optionalQuestions', priority: 'low',
      title: 'A few optional questions',
      text: 'These are optional — answer only what you are comfortable sharing.',
      reason: `${plural(optionalMissing.length, 'optional question is', 'optional questions are')} unanswered, such as ${optionalMissing[0].label.toLowerCase()}.`,
      action: 'See questions', actionTarget: TARGET.MORE_ABOUT_YOU }));
  }

  return out.sort((a, b2) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b2.priority]);
}

// ── Health ──────────────────────────────────────────────────────────────────

const COMPLETION_DEFINITION =
  'Each profile question, your profile photo and photo verification count equally. ' +
  'Host questions only count if you chose to become an Activity Host.';

function buildHealth(facts, suggestions) {
  const required = facts.completion.missing.filter(m => !m.optional && m.key !== 'photoVerification');
  const optional = facts.completion.missing.filter(m => m.optional);
  return {
    completion: {
      percentage: facts.completion.percentage,
      completed: facts.completion.completed,
      applicable: facts.completion.applicable,
      definition: COMPLETION_DEFINITION,
      note: 'Completeness only counts what is filled in. It is not a rating of your profile or of you.',
    },
    // `current` is the user's own bio, returned only to them, so the Bio Assistant
    // can show what a new draft would replace.
    bio: { status: facts.bio.status, length: facts.bio.length, maxLength: BIO_MAX, message: facts.bio.message, current: facts.bio.text },
    interests: {
      count: facts.interests.count,
      sample: facts.interests.items.slice(0, 6),
      message: facts.interests.count === 0
        ? "You haven't listed hobbies or interests yet."
        : `You've listed ${plural(facts.interests.count, 'hobby or interest', 'hobbies and interests')}.`,
    },
    verification: {
      status: facts.verification.status,
      label: facts.verification.label,
      message: facts.verification.message,
      rejectionReason: facts.verification.rejectionReason || null,
      target: TARGET.VERIFICATION,
    },
    trustSteps: [
      { key: 'photo_verification', label: 'Photo verification', done: facts.verification.status === 'approved',
        status: facts.verification.status, target: TARGET.VERIFICATION },
      { key: 'email_verification', label: 'Email verified', done: facts.emailVerified,
        status: facts.emailVerified ? 'done' : 'not_done', target: TARGET.PROFILE },
    ],
    missingRequired: required.map(({ key, label, target }) => ({ key, label, target })),
    missingOptional: optional.map(({ key, label, target }) => ({ key, label, target })),
    improvements: suggestions.slice(0, 3).map(s => ({ id: s.id, title: s.title, action: s.action, actionTarget: s.actionTarget })),
  };
}

// ── Deterministic guidance per intent ───────────────────────────────────────
//
// Used three ways: as the answer when the AI is unavailable, as grounding facts
// handed to the AI, and to decide which in-app buttons the reply carries (the AI
// never chooses navigation).

function topSuggestionLines(suggestions, n) {
  return suggestions.slice(0, n).map(s => `${s.title}: ${s.reason}`);
}

function buildGuidance(intent, facts, suggestions) {
  const actions = [];
  const addAction = (label, target) => {
    if (!actions.some(a => a.target === target)) actions.push({ label, target });
  };

  switch (intent) {
    case 'improve_profile':
    case 'first_improve': {
      if (suggestions.length === 0) {
        return { intro: 'Nothing important is missing from your profile right now.',
          bullets: ['You can keep your bio and availability current whenever things change.'], actions };
      }
      const top = suggestions[0];
      addAction(top.action, top.actionTarget);
      return {
        intro: intent === 'first_improve'
          ? `I'd start with this: ${top.title.toLowerCase()}.`
          : 'Here is what would help most, based on your profile:',
        bullets: intent === 'first_improve'
          ? [top.reason, top.text]
          : topSuggestionLines(suggestions, 4),
        actions,
      };
    }

    case 'bio_help': {
      addAction('Open Bio Assistant', TARGET.BIO_ASSISTANT);
      const bullets = [facts.bio.message];
      bullets.push(`Bios can be up to ${BIO_MAX} characters. Phone numbers, links and social handles are not allowed.`);
      bullets.push('One or two things you enjoy and the kind of plans you like is plenty.');
      return { intro: 'Bio tips:', bullets, actions };
    }

    case 'complete_profile': {
      const required = facts.completion.missing.filter(m => !m.optional);
      const optional = facts.completion.missing.filter(m => m.optional);
      if (facts.completion.missing.length === 0) {
        return { intro: `Your profile is ${facts.completion.percentage}% complete — everything that counts is filled in.`,
          bullets: [], actions };
      }
      const next = required[0] || optional[0];
      addAction(`Open ${next.label.toLowerCase()}`, next.target);
      const bullets = required.slice(0, 4).map(m => m.label);
      if (optional.length > 0) bullets.push(`${plural(optional.length, 'optional question', 'optional questions')} — only if you want to share`);
      return { intro: `Your profile is ${facts.completion.percentage}% complete (${facts.completion.completed} of ${facts.completion.applicable} items). Still to do:`,
        bullets, actions };
    }

    case 'verification_help': {
      const v = facts.verification;
      const bullets = [v.message];
      if (v.status === 'not_started' || v.status === 'rejected') {
        bullets.push('You need camera and microphone permission, good light, and your face clearly visible.');
        bullets.push('After you upload, the Humrah team reviews the video. Your status shows "Under review" until then.');
        addAction(v.status === 'rejected' ? 'Record a new video' : 'Start verification', TARGET.VERIFICATION);
      }
      bullets.push('Filling in your bio or questionnaire does not verify you — only an approved verification video does.');
      return { intro: `Verification status: ${v.label}.`, bullets, actions };
    }

    case 'booking_help': {
      if (facts.accountStatus !== 'ACTIVE') {
        addAction('Contact support', TARGET.SUPPORT);
        return { intro: 'Your account is restricted, which affects bookings.',
          bullets: [`Account status: ${facts.accountStatus}.`], actions };
      }
      if (!facts.host.isHost) {
        addAction('Open profile questions', TARGET.PROFILE_QUESTIONS);
        return { intro: "Bookings are for Activity Hosts, and you haven't turned on Activity Host Mode.",
          bullets: ['To host activities, answer "Yes, I\'m interested" to the Activity Host Mode question in your profile questions, then add the activities you offer, your availability, cost sharing and a tagline.'],
          actions };
      }
      const failing = facts.host.discoveryChecks.filter(c => !c.ok);
      const bullets = [];
      if (facts.bookings.available) {
        const s = facts.bookings;
        bullets.push(`Requests you've received in the last 90 days: ${s.last90Days}. All time: ${s.completed} completed, ${s.confirmed} confirmed, ${s.pending} pending, ${s.cancelled} cancelled.`);
      }
      failing.forEach(c => bullets.push(`Not yet: ${c.label}.`));
      if (failing.length === 0) {
        bullets.push('Everything Humrah checks for listing hosts is in place.');
        bullets.push("Humrah can't see why individual members choose not to book, so I can't point to one exact cause.");
      }
      if (failing.some(c => c.key === 'hosting_on' || c.key === 'host_mode')) addAction('Open host settings', TARGET.HOST_SETTINGS);
      else if (failing.some(c => c.key === 'verified')) addAction('Start verification', TARGET.VERIFICATION);
      else if (failing.some(c => c.key === 'profile_photo' || c.key === 'city')) addAction('Open profile', TARGET.PROFILE);
      return { intro: failing.length > 0 ? 'Here is what I can see on your host profile:' : 'Your host profile meets the listing requirements.',
        bullets, actions };
    }

    default:
      return null;
  }
}

// ── Minimal AI context ──────────────────────────────────────────────────────
//
// An explicit allow-list. Never the user document: no name, email, phone, date
// of birth, gender, exact or approximate location, payment details, moderation
// records or other people's data.

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);
const clipList = (list, n = 10, len = 60) => list.slice(0, n).map(x => clip(x, len));

function buildAiContext(facts) {
  const p = facts.profile;
  const ctx = {
    profile: {
      bio: facts.bio.text ? clip(facts.bio.text, 300) : null,
      hobbiesAndInterests: clipList(facts.interests.items, 12),
      vibeWords: clipList(p.vibeWords),
      whenUsuallyFree: clipList(p.availableTimes),
      comfortActivities: clipList(p.comfortActivity),
      howTheyRelax: clipList(p.relaxActivity),
      music: clipList(p.musicPreference),
      comfortableMeetingPlaces: clipList(p.comfortZones),
      hangoutStyle: clipList(p.hangoutPreferences),
      meetupPreference: clip(p.meetupPreference, 60),
      socialVibe: clip(p.socialVibe, 60),
      personalityType: clip(p.personalityType, 60),
      whatMakesAHangoutGreat: clip(p.goodMeetupMeaning, 200),
      quoteOrMotto: clip(p.vibeQuote, 120),
    },
    hasProfilePhoto: facts.hasPhoto,
    citySet: facts.hasCity,
    completion: {
      percentage: facts.completion.percentage,
      missing: facts.completion.missing.filter(m => !m.optional).map(m => m.label).slice(0, 12),
      optionalMissing: facts.completion.missing.filter(m => m.optional).map(m => m.label).slice(0, 12),
    },
    bio: { status: facts.bio.status, length: facts.bio.length, maxLength: BIO_MAX },
    verification: { status: facts.verification.status, detail: facts.verification.message },
    activityHost: facts.host.isHost ? {
      hostModeOn: facts.host.hostModeOn,
      hostingPaused: facts.host.hostingPaused,
      activitiesOffered: clipList(facts.host.openFor),
      availability: clip(facts.host.availability, 80),
      costSharingPreference: facts.host.costSharingPreference,
      hasTagline: facts.host.hasTagline,
      upiSetUp: facts.host.hasUpi,
      listingChecks: facts.host.discoveryChecks.map(c => ({ check: c.label, met: c.ok })),
      bookings: facts.bookings.available
        ? { last90Days: facts.bookings.last90Days, completed: facts.bookings.completed, confirmed: facts.bookings.confirmed,
            pending: facts.bookings.pending, cancelled: facts.bookings.cancelled }
        : 'not available',
      ratings: { average: facts.ratings.average, count: facts.ratings.count },
    } : 'not an Activity Host',
  };
  if (facts.accountStatus !== 'ACTIVE') ctx.accountStatus = facts.accountStatus;
  return ctx;
}

module.exports = {
  TARGET,
  ITEM_INFO,
  BIO_MIN_SAVE,
  BIO_MAX,
  isBioSafe,
  itemInfo,
  assessBio,
  verificationState,
  buildFacts,
  buildSuggestions,
  buildHealth,
  buildGuidance,
  buildAiContext,
};
