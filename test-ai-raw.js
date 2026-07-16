require('dotenv').config();
const axios = require('axios');
const { buildRephrasePrompt } = require('./services/broadcastAiService');

// I have to copy buildRephrasePrompt because it's not exported
function buildRephrasePromptLocal(title, message, tone, language) {
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

async function run() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const prompt = buildRephrasePromptLocal('Weekend Meetup', 'Join us this weekend to meet new people, make friends, and enjoy a fun activity together. We hope to see you there.', 'Professional', 'en');

  try {
    const res = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 512,
        topP: 0.9,
      }
    });
    console.log(JSON.stringify(res.data, null, 2));
  } catch(e) {
    console.error(e.response ? e.response.data : e.message);
  }
}
run();
