/**
 * calculateProfileCompletion(user)
 *
 * SINGLE SOURCE OF TRUTH for profile completion across the entire
 * Humrah platform (Android App, Admin Dashboard, Analytics, Events).
 *
 * Architecture:
 *   - Weighted categories  (not equal per-field)
 *   - Per-field evaluation  (not section-based OR logic)
 *   - Dynamic denominator   (host fields only counted when applicable)
 *   - Returns { percentage, breakdown, missingFields }
 *
 * Category base weights:
 *   Registration  : 40   (onboarding fields already collected)
 *   Profile       : 30   (detailed questionnaire fields)
 *   Photos        : 10   (profile photo)
 *   Verification  : 10   (photo verification approval)
 *   Host          : 10   (only when user selects "Yes, I'm interested")
 *
 * When host mode is NOT applicable, its weight is excluded and the
 * remaining weights are normalized to 100%.
 */

// ── Base weights per category ─────────────────────────────────────────
const CATEGORY_BASE_WEIGHTS = {
  registration:  40,
  profile:       30,
  photos:        10,
  verification:  10,
  host:          10,
};

// ── Helpers ───────────────────────────────────────────────────────────
const isBlank = (v) => !v || String(v).trim().length === 0;
const isEmpty = (v) => !v || !Array.isArray(v) || v.length === 0;

// ── Main ──────────────────────────────────────────────────────────────
const calculateProfileCompletion = (user) => {
  if (!user) {
    return { percentage: 0, breakdown: {}, missingFields: [] };
  }

  const q = user.questionnaire || {};
  const isHost = q.becomeCompanion === "Yes, I'm interested";

  // ================================================================
  // 1. REGISTRATION — Onboarding fields (collected during signup)
  // ================================================================
  const registrationFields = [
    { key: 'name',                label: 'Name',                  filled: !isBlank(q.name) },
    { key: 'city',                label: 'City',                  filled: !isBlank(q.city) },
    { key: 'preferredLanguages',  label: 'Preferred Languages',   filled: !isEmpty(q.preferredLanguages) },
    { key: 'ageGroup',            label: 'Age Group',             filled: !isBlank(q.ageGroup) },
    { key: 'hangoutPreferences',  label: 'Hangout Preferences',   filled: !isEmpty(q.hangoutPreferences) },
    { key: 'availableTimes',      label: 'Available Times',       filled: !isEmpty(q.availableTimes) },
    { key: 'meetupPreference',    label: 'Meetup Preference',     filled: !isBlank(q.meetupPreference) },
    { key: 'lookingForOnHumrah',  label: 'Looking For',           filled: !isEmpty(q.lookingForOnHumrah) },
    { key: 'vibeWords',           label: 'Vibe Words',            filled: !isEmpty(q.vibeWords) },
    { key: 'publicPlacesOnly',    label: 'Public Places Only',    filled: !isBlank(q.publicPlacesOnly) },
  ];

  // ================================================================
  // 2. PROFILE — Detailed questionnaire (filled in profile editor)
  // ================================================================
  const profileFields = [
    { key: 'bio',                label: 'Bio',                    filled: !isBlank(q.bio) },
    { key: 'goodMeetupMeaning',  label: 'Great Hangout',          filled: !isBlank(q.goodMeetupMeaning) },
    { key: 'vibeQuote',          label: 'Quote / Motto',          filled: !isBlank(q.vibeQuote) },
    { key: 'comfortActivity',    label: 'Comfort Activities',     filled: !isEmpty(q.comfortActivity) },
    { key: 'relaxActivity',      label: 'Relaxation Activities',  filled: !isEmpty(q.relaxActivity) },
    { key: 'musicPreference',    label: 'Music Preference',       filled: !isEmpty(q.musicPreference) },
    { key: 'budgetComfort',      label: 'Budget Comfort',         filled: !isBlank(q.budgetComfort) },
    { key: 'comfortZones',       label: 'Comfort Zones',          filled: !isEmpty(q.comfortZones) },
    { key: 'hangoutFrequency',   label: 'Hangout Frequency',      filled: !isBlank(q.hangoutFrequency) },
    { key: 'becomeCompanion',    label: 'Host Mode Preference',   filled: !isBlank(q.becomeCompanion) },
  ];

  // ================================================================
  // 3. PHOTOS — Profile photo upload
  // ================================================================
  const photoFields = [
    { key: 'profilePhoto',  label: 'Profile Photo',  filled: !isBlank(user.profilePhoto) },
  ];

  // ================================================================
  // 4. VERIFICATION — Photo verification status
  // ================================================================
  const verificationFields = [
    { key: 'photoVerification',  label: 'Photo Verification',  filled: user.photoVerificationStatus === 'approved' },
  ];

  // ================================================================
  // 5. HOST — Conditional fields (only when host mode selected)
  // ================================================================
  const hostFields = isHost ? [
    { key: 'openFor',                label: 'Open For Activities',       filled: !isEmpty(q.openFor) },
    { key: 'availability',           label: 'Availability',             filled: !isBlank(q.availability) },
    { key: 'costSharingPreference',  label: 'Cost Sharing Preference',  filled: !isBlank(q.costSharingPreference) },
    { key: 'tagline',               label: 'Activity Tagline',         filled: !isBlank(q.tagline) },
  ] : [];

  // ================================================================
  // Build applicable categories and normalize weights
  // ================================================================
  const categories = [
    { name: 'registration',  fields: registrationFields,  baseWeight: CATEGORY_BASE_WEIGHTS.registration },
    { name: 'profile',       fields: profileFields,       baseWeight: CATEGORY_BASE_WEIGHTS.profile },
    { name: 'photos',        fields: photoFields,         baseWeight: CATEGORY_BASE_WEIGHTS.photos },
    { name: 'verification',  fields: verificationFields,  baseWeight: CATEGORY_BASE_WEIGHTS.verification },
  ];

  if (isHost) {
    categories.push({
      name: 'host',
      fields: hostFields,
      baseWeight: CATEGORY_BASE_WEIGHTS.host,
    });
  }

  // Normalize: if host is excluded, remaining weights scale up to 100%
  const totalBaseWeight = categories.reduce((sum, c) => sum + c.baseWeight, 0);

  // ================================================================
  // Calculate per-category scores and overall percentage
  // ================================================================
  let overallPercentage = 0;
  const breakdown = {};
  const missingFields = [];

  for (const category of categories) {
    const normalizedWeight = (category.baseWeight / totalBaseWeight) * 100;
    const total  = category.fields.length;
    const filled = category.fields.filter(f => f.filled).length;
    const categoryPercentage = total > 0 ? Math.round((filled / total) * 100) : 100;
    const contribution       = total > 0 ? (filled / total) * normalizedWeight : normalizedWeight;

    overallPercentage += contribution;

    breakdown[category.name] = {
      filled,
      total,
      percentage: categoryPercentage,
      weight: Math.round(normalizedWeight * 10) / 10,   // e.g. 44.4
    };

    // Collect missing fields for this category
    for (const field of category.fields) {
      if (!field.filled) {
        missingFields.push({
          category: category.name,
          key:      field.key,
          label:    field.label,
        });
      }
    }
  }

  // ── Host metadata when NOT applicable ───────────────────────────────
  if (!isHost) {
    breakdown.host = {
      applicable: false,
      filled:     0,
      total:      0,
      percentage: 100,
      weight:     0,
    };
  } else {
    breakdown.host.applicable = true;
  }

  // ── Overall summary ─────────────────────────────────────────────────
  const totalFields  = categories.reduce((s, c) => s + c.fields.length, 0);
  const filledFields = categories.reduce((s, c) => s + c.fields.filter(f => f.filled).length, 0);
  const finalPercentage = Math.min(Math.max(Math.round(overallPercentage), 0), 100);

  breakdown.overall = {
    percentage:  finalPercentage,
    totalFields,
    filledFields,
  };

  return {
    percentage:  finalPercentage,
    breakdown,
    missingFields,
  };
};

module.exports = { calculateProfileCompletion };
