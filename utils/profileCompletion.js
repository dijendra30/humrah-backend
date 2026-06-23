/**
 * calculateProfileCompletion(user)
 * ONE SINGLE SOURCE OF TRUTH FOR PROFILE COMPLETION.
 *
 * This exact function drives the profile completeness percentage across the
 * entire Humrah platform (Android UI, Admin Dashboard, Analytics, Broadcasts).
 *
 * It uses ONLY fields collected in the Android App during onboarding
 * or within the Questionnaire screens.
 */

const calculateProfileCompletion = (user) => {
  if (!user) return 0;
  let completeness = 0;

  const q = user.questionnaire || {};

  const isNullOrBlank = (str) => !str || str.trim().length === 0;
  const isNullOrEmpty = (arr) => !arr || arr.length === 0;

  // ==========================================
  // 1. PHOTOS & VERIFICATION (30%)
  // ==========================================
  if (!isNullOrBlank(user.profilePhoto)) {
    completeness += 15;
  }
  if (user.photoVerificationStatus === 'approved') {
    completeness += 15;
  }

  // ==========================================
  // 2. BASIC ONBOARDING INFO (20%)
  // ==========================================
  // Location & Age (5%)
  if (!isNullOrBlank(q.city) && !isNullOrBlank(q.ageGroup)) {
    completeness += 5;
  }

  // Preferences (5%)
  if (!isNullOrEmpty(q.preferredLanguages) && !isNullOrBlank(q.meetupPreference)) {
    completeness += 5;
  }

  // Vibe (10%)
  if (!isNullOrEmpty(q.lookingForOnHumrah) && !isNullOrEmpty(q.vibeWords)) {
    completeness += 10;
  }

  // ==========================================
  // 3. DETAILED QUESTIONNAIRE (50%)
  // ==========================================
  
  // About You (10%)
  if (!isNullOrBlank(q.bio) || !isNullOrBlank(q.goodMeetupMeaning) || !isNullOrBlank(q.vibeQuote)) {
    completeness += 10;
  }

  // Lifestyle (10%)
  if (!isNullOrEmpty(q.comfortActivity) || !isNullOrEmpty(q.relaxActivity) || !isNullOrEmpty(q.musicPreference)) {
    completeness += 10;
  }

  // Hangout Preferences (10%)
  if (!isNullOrBlank(q.budgetComfort) || !isNullOrEmpty(q.comfortZones) || !isNullOrBlank(q.hangoutFrequency)) {
    completeness += 10;
  }

  // Companion Mode (10%)
  if (!isNullOrBlank(q.becomeCompanion)) {
    if (q.becomeCompanion === "Yes, I'm interested") {
      if (!isNullOrBlank(q.tagline) || !isNullOrEmpty(q.openFor)) {
        completeness += 10;
      }
    } else {
      completeness += 10;
    }
  }

  // Trust & Guidelines (10%)
  if (!isNullOrBlank(q.verifyIdentity) || !isNullOrBlank(q.understandGuidelines)) {
    completeness += 10;
  }

  // Ensure bounds
  return Math.min(Math.max(completeness, 0), 100);
};

module.exports = { calculateProfileCompletion };
