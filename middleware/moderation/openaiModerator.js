const axios = require('axios');

const OPENAI_MODERATION_URL = 'https://api.openai.com/v1/moderations';

/**
 * Thresholds — tune these based on your false-positive tolerance.
 * Lower = stricter. These are conservative starting points.
 */
const CATEGORY_THRESHOLDS = {
  sexual:                    0.5,
  'sexual/minors':           0.1,   // near-zero tolerance
  harassment:                0.6,
  'harassment/threatening':  0.4,
  hate:                      0.5,
  'hate/threatening':        0.4,
  violence:                  0.7,
  'violence/graphic':        0.5,
  'self-harm':               0.4,
  'self-harm/intent':        0.2,
  'self-harm/instructions':  0.2,
};

/**
 * Calls OpenAI moderation on the given text.
 * Returns { safe: boolean, flaggedCategories: string[], scores: object }
 *
 * API key is read from process.env — NEVER passed from client.
 */
async function checkWithOpenAI(text) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    // Fail open with a warning in dev; fail closed in production
    if (process.env.NODE_ENV === 'production') {
      throw new Error('OPENAI_API_KEY not configured');
    }
    console.warn('[MODERATION] OPENAI_API_KEY missing — skipping AI check in dev');
    return { safe: true, flaggedCategories: [], scores: {} };
  }

  const response = await axios.post(
    OPENAI_MODERATION_URL,
    { input: text },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000, // 5s timeout — don't block user forever
    }
  );

  const result = response.data.results[0];
  const scores = result.category_scores;
  const flaggedCategories = [];

  for (const [category, threshold] of Object.entries(CATEGORY_THRESHOLDS)) {
    if (scores[category] !== undefined && scores[category] >= threshold) {
      flaggedCategories.push(category);
    }
  }

  return {
    safe: flaggedCategories.length === 0,
    flaggedCategories,
    scores,
    openAiFlagged: result.flagged, // OpenAI's own binary decision
  };
}

module.exports = { checkWithOpenAI };
