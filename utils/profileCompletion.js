/**
 * Utility to calculate user profile completion percentage.
 * Initial weights:
 * - Profile Photo -> 20%
 * - Basic Information (Name, Age/DOB, Gender) -> 15%
 * - Bio/About -> 10%
 * - Questionnaire -> 25%
 * - Trust & Safety Preferences -> 10%
 * - Photo Verification -> 20%
 */

const calculateProfileCompletion = (user) => {
  let score = 0;
  const breakdown = {
    basicInfo: false,
    profilePhoto: false,
    bio: false,
    questionnaire: false,
    trustSafety: false,
    photoVerification: false
  };

  const q = user.questionnaire || {};

  // 1. Profile Photo (20%)
  if (user.profilePhoto && user.profilePhoto.trim() !== '') {
    score += 20;
    breakdown.profilePhoto = true;
  }

  // 2. Basic Information (15%)
  // Needs firstName, lastName, and (age/ageGroup or DOB), and gender
  const hasName = user.firstName && user.lastName;
  const hasAgeOrDob = user.age || q.ageGroup || q.dateOfBirth || user.dateOfBirth;
  const hasGender = q.gender;
  
  if (hasName && hasAgeOrDob && hasGender) {
    score += 15;
    breakdown.basicInfo = true;
  } else if (hasName || hasAgeOrDob || hasGender) {
    // Partial credit
    score += 7;
  }

  // 3. Bio/About (10%)
  if (q.bio && q.bio.trim() !== '') {
    score += 10;
    breakdown.bio = true;
  }

  // 4. Questionnaire (25%)
  // Check a few key questionnaire fields to determine if filled
  const qFields = [
    q.lookingForOnHumrah,
    q.interests,
    q.hobbies,
    q.musicPreference,
    q.favoriteFood,
    q.profession,
    q.education,
    q.lookingFor,
    q.relationshipStatus,
    q.smokingStatus,
    q.drinkingStatus
  ];
  
  // Count how many of these arrays/strings have values
  const filledQFields = qFields.filter(f => {
    if (Array.isArray(f)) return f.length > 0;
    return f && f.trim() !== '';
  }).length;

  if (filledQFields >= 4) { // Consider questionnaire "complete" if at least 4 key fields are filled
    score += 25;
    breakdown.questionnaire = true;
  } else if (filledQFields > 0) {
    // Partial credit: up to 15% based on how many are filled
    score += Math.min(15, filledQFields * 5);
  }

  // 5. Trust & Safety Preferences (10%)
  const hasGuidelines = user.guidelinesAccepted || q.understandGuidelines;
  if (hasGuidelines) {
    score += 10;
    breakdown.trustSafety = true;
  }

  // 6. Photo Verification (20%)
  if (user.verified || user.photoVerificationStatus === 'approved') {
    score += 20;
    breakdown.photoVerification = true;
  }

  // Ensure score doesn't exceed 100
  score = Math.min(100, Math.round(score));

  return {
    completionPercentage: score,
    breakdown
  };
};

module.exports = { calculateProfileCompletion };
