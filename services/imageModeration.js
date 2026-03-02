// services/imageModeration.js
const axios = require('axios');

const LIKELIHOOD_LEVELS = {
  UNKNOWN: 0,
  VERY_UNLIKELY: 1,
  UNLIKELY: 2,
  POSSIBLE: 3,
  LIKELY: 4,
  VERY_LIKELY: 5
};

const getLikelihoodValue = (likelihood) => LIKELIHOOD_LEVELS[likelihood] ?? 0;

/**
 * Analyze image with Google Cloud Vision SafeSearch
 * @param {string} imageBase64 - raw base64 or data URL
 * @returns {Object} moderation result
 */
const analyzeImageSafety = async (imageBase64) => {
  try {
    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_VISION_API_KEY is not configured');

    const base64Data = imageBase64.startsWith('data:')
      ? imageBase64.split(',')[1]
      : imageBase64;

    const { data } = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        requests: [{
          image: { content: base64Data },
          features: [{ type: 'SAFE_SEARCH_DETECTION' }]
        }]
      },
      { timeout: 15000 }
    );

    const annotation = data?.responses?.[0]?.safeSearchAnnotation;

    if (!annotation) {
      console.warn('⚠️  Vision API returned no annotation — failing open');
      return { safe: true, scores: {}, blocked: false, extremeContent: false, apiError: 'no annotation' };
    }

    const scores = {
      adult:    annotation.adult    || 'UNKNOWN',
      racy:     annotation.racy     || 'UNKNOWN',
      violence: annotation.violence || 'UNKNOWN',
      spoof:    annotation.spoof    || 'UNKNOWN',
      medical:  annotation.medical  || 'UNKNOWN'
    };

    const adultVal    = getLikelihoodValue(scores.adult);
    const violenceVal = getLikelihoodValue(scores.violence);
    const racyVal     = getLikelihoodValue(scores.racy);

    // Extreme content = immediate 7-day account suspension (bypasses strike system)
    const extremeContent =
      adultVal    >= LIKELIHOOD_LEVELS.VERY_LIKELY ||
      violenceVal >= LIKELIHOOD_LEVELS.VERY_LIKELY;

    // Standard block rules
    let blocked = false, blockReason = null;
    if      (adultVal    >= LIKELIHOOD_LEVELS.LIKELY)      { blocked = true; blockReason = 'adult'; }
    else if (violenceVal >= LIKELIHOOD_LEVELS.LIKELY)      { blocked = true; blockReason = 'violence'; }
    else if (racyVal     >= LIKELIHOOD_LEVELS.VERY_LIKELY) { blocked = true; blockReason = 'racy'; }

    console.log('🔍 SafeSearch result:', {
      adult: scores.adult, violence: scores.violence,
      racy: scores.racy, blocked, extremeContent
    });

    return { safe: !blocked, scores, rawResponse: annotation, blocked, blockReason, extremeContent };

  } catch (error) {
    console.error('❌ Vision API error:', error.message);
    // Fail open on API errors so legitimate uploads are never blocked by infrastructure issues
    return {
      safe: true, scores: {}, rawResponse: null,
      blocked: false, blockReason: null, extremeContent: false,
      apiError: error.message
    };
  }
};

module.exports = { analyzeImageSafety, getLikelihoodValue, LIKELIHOOD_LEVELS };
