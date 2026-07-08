// helpers/eventEligibility.js

function normalizeStr(str) {
  return str && typeof str === 'string' ? str.trim().toLowerCase() : str;
}

function canUserJoinEvent(user, event) {
  if (event.status !== 'Published') return false;

  const userState = user.questionnaire?.state || user.state;
  const userCity  = user.questionnaire?.city  || user.city;
  const userAge   = user.questionnaire?.age;
  const userGender = user.questionnaire?.gender;
  const profileCompletion = user.profileCompletion || 0;
  const isVerified = user.photoVerificationStatus === 'approved';

  // Visibility
  if (event.visibility === 'Verified Users Only' && !isVerified) {
    return false;
  }

  // Target Audience
  let audienceMatch = false;
  if (event.targetAudience === 'Everyone') {
    audienceMatch = true;
  } else if (event.targetAudience === 'Verified Users Only' && isVerified) {
    audienceMatch = true;
  } else if (event.targetAudience === 'Profile Completion > 70%' && profileCompletion >= 70) {
    audienceMatch = true;
  } else if (event.targetAudience === 'Profile Completion > 90%' && profileCompletion >= 90) {
    audienceMatch = true;
  } else if (event.targetAudience === 'Premium Users Only') {
    // Requires future implementation for premium checks
    // Defaulting to false for now unless user has some premium flag
    audienceMatch = false;
  } else if (event.targetAudience === 'Custom Filter') {
    const cf = event.customFilters || {};
    let cfMatch = true;
    if (cf.minProfileCompletion > profileCompletion) cfMatch = false;
    if (cf.gender && cf.gender !== 'All' && cf.gender !== userGender) cfMatch = false;

    if (cf.ageRange && cf.ageRange !== 'Any') {
      if (!userAge) {
        cfMatch = false;
      } else if (cf.ageRange === '18-24' && (userAge < 18 || userAge > 24)) cfMatch = false;
      else if (cf.ageRange === '25-30' && (userAge < 25 || userAge > 30)) cfMatch = false;
      else if (cf.ageRange === '31-40' && (userAge < 31 || userAge > 40)) cfMatch = false;
      else if (cf.ageRange === 'Custom Range' && cf.minAge && cf.maxAge && (userAge < cf.minAge || userAge > cf.maxAge)) cfMatch = false;
    }
    if (cfMatch) audienceMatch = true;
  }

  if (!audienceMatch) return false;

  // Geographic Targeting
  const userStateNorm = normalizeStr(userState);
  const userCityNorm  = normalizeStr(userCity);
  let geoMatch = false;

  if (!event.geographicTargeting || event.geographicTargeting.level === 'Entire India') {
    geoMatch = true;
  } else if (event.geographicTargeting.level === 'State') {
    if (normalizeStr(event.geographicTargeting.state) === userStateNorm) geoMatch = true;
  } else if (event.geographicTargeting.level === 'State + District') {
    if (normalizeStr(event.geographicTargeting.state) === userStateNorm && normalizeStr(event.geographicTargeting.district) === userCityNorm) geoMatch = true;
  }

  if (!geoMatch) return false;

  return true;
}

module.exports = { canUserJoinEvent };
