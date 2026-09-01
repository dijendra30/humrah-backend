const AiProvider = require('./aiProviderAbstract');
const axios = require('axios');

class GroqProvider extends AiProvider {
  async extractProfile(userText, schemaPrompt) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY not configured');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: schemaPrompt },
          { role: 'user', content: userText }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000 // 8s strict timeout
      }
    );

    const content = response.data.choices[0].message.content;
    return JSON.parse(content);
  }
}

module.exports = new GroqProvider();
