require('dotenv').config();
const axios = require('axios');

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY missing');
    return;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  try {
    const res = await axios.get(url);
    console.log('Available models:');
    res.data.models.forEach(m => {
      console.log(`- ${m.name} (methods: ${m.supportedGenerationMethods.join(', ')})`);
    });
  } catch (e) {
    console.error(`Error listing models:`);
    console.error(e.response ? e.response.data : e.message);
  }
}

listModels();
