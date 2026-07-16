require('dotenv').config();
const axios = require('axios');

async function testGemini(model) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await axios.post(url, { contents: [{ parts: [{ text: 'Join us this weekend to meet new people, make friends, and enjoy a fun activity together.' }] }] });
    console.log(`Success with ${model}:`, res.data.candidates[0].content.parts[0].text.substring(0, 50) + '...');
  } catch (e) {
    console.error(`Error with ${model}:`, e.response ? e.response.data.error.message : e.message);
  }
}

async function run() {
  await testGemini('gemini-flash-latest');
  await testGemini('gemini-3.5-flash');
  await testGemini('gemini-2.0-flash');
}

run();
