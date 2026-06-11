// services/geminiService.js
// Gemini AI risk analysis for Humrah Safety System.
//
// Uses gemini-2.0-flash via REST (no SDK needed — axios is already in the project).
// Falls back to rule-based classification when GEMINI_API_KEY is absent or the
// call fails, so the safety flow is never blocked by an AI outage.

'use strict';

const axios = require('axios');

const GEMINI_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const VALID_RISK_LEVELS   = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const VALID_CATEGORIES    = [
    'General Discomfort',
    'Harassment',
    'Sexual Harassment',
    'Threats',
    'Scam',
    'Fraud',
    'Coercion',
    'Stalking',
    'Physical Safety Risk',
    'Emergency Risk'
];

// ─────────────────────────────────────────────────────────────────────────────
// Rule-based defaults (applied before Gemini for non-"something_else" types)
// ─────────────────────────────────────────────────────────────────────────────
const RULE_BASED_RISK = {
    felt_pressured_or_unsafe: { riskLevel: 'CRITICAL', riskScore: 90, detectedCategory: 'Physical Safety Risk' },
    inappropriate_message:    { riskLevel: 'HIGH',     riskScore: 65, detectedCategory: 'Harassment'           },
    felt_uncomfortable:       { riskLevel: 'MEDIUM',   riskScore: 40, detectedCategory: 'General Discomfort'   }
};

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse a safety concern and return risk metadata.
 *
 * @param {object} params
 * @param {string} params.concernType   - One of the four UI concern types
 * @param {string} params.note          - User's free-text note (max 500 chars)
 * @param {Array}  params.chatContext   - Recent messages snapshot [{sender,text}]
 * @returns {Promise<{riskLevel, riskScore, summary, detectedCategory}>}
 */
async function analyzeRisk({ concernType, note, chatContext = [] }) {
    // ── Step 1: rule-based fast path ──────────────────────────────────────────
    if (concernType !== 'something_else') {
        const rule = RULE_BASED_RISK[concernType];
        return {
            riskLevel:        rule.riskLevel,
            riskScore:        rule.riskScore,
            summary:          buildRuleBasedSummary(concernType, note),
            detectedCategory: rule.detectedCategory,
            geminiAnalyzed:   false
        };
    }

    // ── Step 2: Gemini analysis for "something_else" ──────────────────────────
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn('[Gemini] GEMINI_API_KEY not set — using fallback classification.');
        return fallback(note);
    }

    try {
        const prompt = buildPrompt(note, chatContext);
        const response = await axios.post(
            `${GEMINI_URL}?key=${apiKey}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature:     0.1,   // low temperature for consistent JSON
                    maxOutputTokens: 256,
                    topP:            0.8
                }
            },
            { timeout: 10_000 }
        );

        const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        return parseGeminiResponse(raw);
    } catch (err) {
        console.error('[Gemini] Analysis failed:', err.message);
        return fallback(note);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt(note, chatContext) {
    const contextStr = chatContext.length
        ? chatContext.slice(-5).map(m => `${m.sender || 'User'}: ${m.text || ''}`).join('\n')
        : 'No additional context.';

    return `You are a safety risk analyzer for Humrah, a social meetup platform.
Analyze the following safety concern from a user and classify the risk.

Concern: "${note || 'No note provided'}"

Recent Conversation Context:
${contextStr}

Respond ONLY with a valid JSON object (no markdown, no explanation):
{
  "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL",
  "riskScore": <integer 0-100>,
  "summary": "<one concise sentence describing the concern>",
  "detectedCategory": "<one of: ${VALID_CATEGORIES.join(' | ')}>"
}

Guidelines:
- LOW      = general discomfort, vague concern
- MEDIUM   = uncomfortable interaction, mild harassment
- HIGH     = explicit harassment, inappropriate contact, scam attempt
- CRITICAL = physical threats, stalking, sexual harassment, emergency risk`;
}

function parseGeminiResponse(raw) {
    try {
        // Strip markdown fences if present
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const parsed  = JSON.parse(cleaned);

        const riskLevel        = VALID_RISK_LEVELS.includes(parsed.riskLevel)
            ? parsed.riskLevel : 'MEDIUM';
        const riskScore        = Number.isInteger(parsed.riskScore)
            ? Math.min(100, Math.max(0, parsed.riskScore)) : 50;
        const summary          = typeof parsed.summary === 'string' && parsed.summary.length < 400
            ? parsed.summary : 'Safety concern submitted for review.';
        const detectedCategory = VALID_CATEGORIES.includes(parsed.detectedCategory)
            ? parsed.detectedCategory : 'General Discomfort';

        return { riskLevel, riskScore, summary, detectedCategory, geminiAnalyzed: true };
    } catch {
        return fallback('');
    }
}

function buildRuleBasedSummary(concernType, note) {
    const base = {
        felt_pressured_or_unsafe: 'User reported feeling pressured or unsafe during an interaction.',
        inappropriate_message:    'User reported receiving an inappropriate message.',
        felt_uncomfortable:       'User reported feeling uncomfortable during an interaction.'
    }[concernType] ?? 'Safety concern submitted for review.';
    return note ? `${base} Note: "${note.substring(0, 100)}${note.length > 100 ? '…' : ''}"` : base;
}

function fallback(note) {
    // Keyword-based quick classification when Gemini is unavailable
    const text     = (note || '').toLowerCase();
    const critical = ['stalk', 'follow me', 'threat', 'kill', 'hurt', 'rape', 'attack', 'emergency'];
    const high     = ['touch', 'sexual', 'nude', 'photo', 'blackmail', 'money', 'scam', 'fraud'];
    const medium   = ['uncomfortable', 'weird', 'strange', 'creepy', 'pressure'];

    let riskLevel = 'LOW'; let riskScore = 20; let detectedCategory = 'General Discomfort';
    if (critical.some(k => text.includes(k)))      { riskLevel = 'CRITICAL'; riskScore = 92; detectedCategory = 'Emergency Risk';      }
    else if (high.some(k => text.includes(k)))     { riskLevel = 'HIGH';     riskScore = 70; detectedCategory = 'Harassment';          }
    else if (medium.some(k => text.includes(k)))   { riskLevel = 'MEDIUM';   riskScore = 45; detectedCategory = 'General Discomfort'; }

    return {
        riskLevel,
        riskScore,
        summary:          'Safety concern submitted. Automated analysis was unavailable.',
        detectedCategory,
        geminiAnalyzed:   false
    };
}

module.exports = { analyzeRisk };
