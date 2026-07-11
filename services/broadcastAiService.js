// services/broadcastAiService.js — Gemini AI rephrase for broadcast content (Phase 1)
// Calls Gemini REST API on-demand only (never automatically).
// Model is configurable via GEMINI_MODEL env var.

'use strict';

const axios = require('axios');

/**
 * Intelligent truncation without cutting words in half.
 */
function smartTruncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  // Shorten to maxLength - 3 to leave room for ellipsis, then cut at last space
  const trimmed = text.substring(0, maxLength - 3);
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace > 0) {
    return trimmed.substring(0, lastSpace) + '...';
  }
  return trimmed + '...';
}

/**
 * Clean up text from API response
 */
function cleanText(text) {
  if (!text) return '';
  return text.trim().replace(/[\r\n]+/g, ' '); // Remove unnecessary line breaks
}

/**
 * Rephrase broadcast content using Gemini AI.
 */
async function rephraseContent({ title, message, tone, language }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Cannot perform AI rephrase.');
  }

  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  console.log(`[BroadcastAI] Calling Gemini (model=${model}) for rephrase. Tone: ${tone}, Language: ${language}`);

  // Attempt 1: Standard AI generation
  let parsed = await callGemini(GEMINI_URL, apiKey, buildRephrasePrompt(title, message, tone, language, false));
  
  // Validate Attempt 1
  let titleValid = parsed.improvedTitle && parsed.improvedTitle.length <= 60;
  let messageValid = parsed.improvedMessage && parsed.improvedMessage.length <= 150;

  if (!titleValid || !messageValid) {
    console.warn(`[BroadcastAI] Attempt 1 exceeded limits (Title: ${parsed.improvedTitle?.length}, Msg: ${parsed.improvedMessage?.length}). Retrying strictly...`);
    // Attempt 2: Strict constraint generation
    try {
      const strictParsed = await callGemini(GEMINI_URL, apiKey, buildRephrasePrompt(title, message, tone, language, true));
      
      // Update parsed if valid, otherwise we will manually shorten it
      if (strictParsed.improvedTitle) parsed.improvedTitle = strictParsed.improvedTitle;
      if (strictParsed.improvedMessage) parsed.improvedMessage = strictParsed.improvedMessage;
      if (strictParsed.hindiTranslation) parsed.hindiTranslation = strictParsed.hindiTranslation;
    } catch (e) {
      console.error('[BroadcastAI] Second attempt failed, falling back to smart truncation on first attempt.');
    }
  }

  // Final Validation & Intelligent Shortening
  parsed.improvedTitle = smartTruncate(cleanText(parsed.improvedTitle), 60);
  parsed.improvedMessage = smartTruncate(cleanText(parsed.improvedMessage), 150);

  if (parsed.hindiTranslation) {
    parsed.hindiTranslation.title = smartTruncate(cleanText(parsed.hindiTranslation.title), 60);
    parsed.hindiTranslation.message = smartTruncate(cleanText(parsed.hindiTranslation.message), 150);
  }

  console.log('[BroadcastAI] Rephrase successful and validated against production limits.');
  return parsed;
}

async function callGemini(url, apiKey, prompt) {
  try {
    const response = await axios.post(
      `${url}?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature:     0.7,
          maxOutputTokens: 2048,
          topP:            0.9,
        },
      },
      { timeout: 30_000 }
    );

    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return parseGeminiResponse(raw);
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      console.error('[BroadcastAI] Gemini request timed out.');
      throw new Error('AI service timed out. Please try again.');
    }
    if (err.response) {
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
 * Build the prompt for Gemini.
 */
function buildRephrasePrompt(title, message, tone, language, isStrictRetry) {
  const includeHindi = language === 'hi' || language === 'both';
  let languageInstruction = '';
  if (includeHindi) {
    languageInstruction = `
Also provide a Hindi translation of the improved title and message.
Include it as "hindiTranslation" in your response with "title" and "message" keys.`;
  }

  const strictWarning = isStrictRetry ? `
CRITICAL: YOUR PREVIOUS RESPONSE WAS TOO LONG. 
YOU MUST STRICTLY OBEY THESE HARD LIMITS OR THE NOTIFICATION WILL BREAK:
- Title MUST BE UNDER 60 characters.
- Message MUST BE UNDER 150 characters.
Do NOT fail these limits.` : '';

  return `You are a professional notification copywriter for Humrah, a social meetup platform in India.
Your goal is to write highly optimized mobile push notifications for Android/iOS.

Rephrase the following broadcast notification.

Original Title: "${title}"
Original Message: "${message}"
Desired Tone: ${tone}
${languageInstruction}

Respond ONLY with a valid JSON object (no markdown fences, no explanation):
{
  "improvedTitle": "<improved title, max 60 characters>",
  "improvedMessage": "<improved message, max 150 characters>"${includeHindi ? `,
  "hindiTranslation": {
    "title": "<Hindi title, max 60 characters>",
    "message": "<Hindi message, max 150 characters>"
  }` : ''}
}

Guidelines for Mobile Push Notifications:
- Title: Recommended 20-45 characters (HARD LIMIT: 60 characters)
- Message: Recommended 60-120 characters (HARD LIMIT: 150 characters)
- Maximum 2 short sentences.
- One clear call-to-action.
- No paragraphs or line breaks.
- No unnecessary adjectives or filler words.
- No repeated information.
- No emojis unless explicitly requested in the original message.
- Write for maximum notification open rate.
- Sound natural and conversational.
- Never generate email-style or long promotional content.${strictWarning}`;
}

function parseGeminiResponse(raw) {
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.improvedTitle || !parsed.improvedMessage) {
      throw new Error('Missing required fields in AI response');
    }

    const result = {
      improvedTitle: String(parsed.improvedTitle),
      improvedMessage: String(parsed.improvedMessage),
    };

    if (parsed.hindiTranslation?.title && parsed.hindiTranslation?.message) {
      result.hindiTranslation = {
        title: String(parsed.hindiTranslation.title),
        message: String(parsed.hindiTranslation.message),
      };
    }

    return result;
  } catch (parseErr) {
    console.error('[BroadcastAI] Failed to parse Gemini response:', parseErr.message);
    throw new Error('AI returned an invalid response. Please try again.');
  }
}

module.exports = { rephraseContent };
