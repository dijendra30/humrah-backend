// services/broadcastAiService.js — Gemini AI rephrase for broadcast content (Phase 1)
// Calls Gemini REST API on-demand only (never automatically).
// Model is configurable via GEMINI_MODEL env var.

'use strict';

const axios = require('axios');

/**
 * Rephrase broadcast content using Gemini AI.
 *
 * IMPORTANT: This function is ONLY called when the admin explicitly
 * requests AI rephrase. It must never be invoked automatically.
 *
 * @param {object} params
 * @param {string} params.title    - Original broadcast title
 * @param {string} params.message  - Original broadcast message
 * @param {string} params.tone     - Desired tone (e.g., 'professional', 'friendly', 'urgent', 'casual')
 * @param {string} params.language - Target language ('en', 'hi', 'both')
 * @returns {Promise<{ improvedTitle: string, improvedMessage: string, hindiTranslation?: { title: string, message: string } }>}
 * @throws {Error} On API failure (caller must handle — no silent fallback)
 */
async function rephraseContent({ title, message, tone, language }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Cannot perform AI rephrase.');
  }

  // Model is configurable via environment variable
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const prompt = buildRephrasePrompt(title, message, tone, language);

  console.log(`[BroadcastAI] Calling Gemini (model=${model}) for rephrase. Tone: ${tone}, Language: ${language}`);

  try {
    const response = await axios.post(
      `${GEMINI_URL}?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature:     0.7,
          maxOutputTokens: 512,
          topP:            0.9,
        },
      },
      { timeout: 15_000 } // 15-second timeout
    );

    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseGeminiResponse(raw);

    console.log('[BroadcastAI] Rephrase successful.');
    return parsed;
  } catch (err) {
    // Distinguish between timeout and other errors for clear logging
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      console.error('[BroadcastAI] Gemini request timed out after 15s.');
      throw new Error('AI service timed out. Please try again.');
    }

    if (err.response) {
      // Gemini API returned an error response
      const status = err.response.status;
      const detail = err.response.data?.error?.message || 'Unknown API error';
      console.error(`[BroadcastAI] Gemini API error (${status}): ${detail}`);
      throw new Error(`AI service error (${status}): ${detail}`);
    }

    console.error('[BroadcastAI] Gemini request failed:', err.message);
    throw new Error(`AI service unavailable: ${err.message}`);
  }
}

/**
 * Build the prompt for Gemini to rephrase broadcast content.
 */
function buildRephrasePrompt(title, message, tone, language) {
  const includeHindi = language === 'hi' || language === 'both';

  let languageInstruction = '';
  if (includeHindi) {
    languageInstruction = `
Also provide a Hindi translation of the improved title and message.
Include it as "hindiTranslation" in your response with "title" and "message" keys.`;
  }

  return `You are a professional notification copywriter for Humrah, a social meetup platform in India.

Rephrase the following broadcast notification to be more engaging and effective.

Original Title: "${title}"
Original Message: "${message}"
Desired Tone: ${tone}
${languageInstruction}

Respond ONLY with a valid JSON object (no markdown fences, no explanation):
{
  "improvedTitle": "<improved title, max 120 characters>",
  "improvedMessage": "<improved message, max 1000 characters>"${includeHindi ? `,
  "hindiTranslation": {
    "title": "<Hindi title>",
    "message": "<Hindi message>"
  }` : ''}
}

Guidelines:
- Keep the core meaning intact
- Match the requested tone exactly
- Use emojis sparingly and appropriately
- Title should be concise and attention-grabbing
- Message should be clear and actionable
- Respect character limits`;
}

/**
 * Parse Gemini's response and extract the structured data.
 */
function parseGeminiResponse(raw) {
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.improvedTitle || !parsed.improvedMessage) {
      throw new Error('Missing required fields in AI response');
    }

    const result = {
      improvedTitle:   String(parsed.improvedTitle).substring(0, 120),
      improvedMessage: String(parsed.improvedMessage).substring(0, 1000),
    };

    // Include Hindi translation only if present and valid
    if (parsed.hindiTranslation?.title && parsed.hindiTranslation?.message) {
      result.hindiTranslation = {
        title:   String(parsed.hindiTranslation.title),
        message: String(parsed.hindiTranslation.message),
      };
    }

    return result;
  } catch (parseErr) {
    console.error('[BroadcastAI] Failed to parse Gemini response:', parseErr.message);
    console.error('[BroadcastAI] Raw response:', raw?.substring(0, 300));
    throw new Error('AI returned an invalid response. Please try again.');
  }
}

module.exports = { rephraseContent };
