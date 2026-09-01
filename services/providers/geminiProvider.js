const AiProvider = require('./aiProviderAbstract');
const axios = require('axios');

class GeminiProvider extends AiProvider {
  async extractProfile(userText, schemaPrompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        system_instruction: { parts: [{ text: schemaPrompt }] },
        contents: [{ parts: [{ text: userText }] }],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.1
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000 // 8s strict timeout
      }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    return JSON.parse(text);
  }
}

module.exports = new GeminiProvider();
