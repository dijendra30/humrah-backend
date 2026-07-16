require('dotenv').config();
const axios = require('axios');

async function testGemini(model) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY missing');
    return;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    console.log(`Testing model: ${model}`);
    console.log(`URL: ${url}`);
    const res = await axios.post(url, { contents: [{ parts: [{ text: 'Hello' }] }] });
    console.log('Success:', res.data.candidates[0].content.parts[0].text);
  } catch (e) {
    console.error(`Error with ${model}:`);
    console.error(e.response ? e.response.data : e.message);
  }
}

async function run() {
  await testGemini('gemini-1.5-flash');
  await testGemini('gemini-pro');
  await testGemini('gemini-1.5-flash-latest');
}

run();
