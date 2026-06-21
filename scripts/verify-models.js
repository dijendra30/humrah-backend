require('dotenv').config();
const axios = require('axios');

async function testOpenAI() {
  console.log('--- Testing OpenAI Moderation ---');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('FAILURE: OPENAI_API_KEY is missing from .env');
    return false;
  }

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/moderations',
      { input: 'This is a test of the moderation system.' },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 }
    );
    console.log('SUCCESS');
    console.log(`Status Code: ${res.status}`);
    console.log(`Model: ${res.data.model}`);
    return true;
  } catch (err) {
    console.log('FAILURE');
    console.log(`Status Code: ${err.response?.status || 'N/A'}`);
    console.log(`Response Body:`, err.response?.data || err.message);
    return false;
  }
}

async function testCloudflare() {
  console.log('\n--- Testing Cloudflare Llama Guard 3 8B ---');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  
  if (!accountId || !apiToken) {
    console.log('FAILURE: Cloudflare credentials missing from .env');
    return false;
  }

  const model = '@cf/meta/llama-guard-3-8b';
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  try {
    const res = await axios.post(
      url,
      { messages: [{ role: 'user', content: 'This is a safe test message.' }] },
      { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log('SUCCESS');
    console.log(`Status Code: ${res.status}`);
    console.log(`Model Tested: ${model}`);
    console.log(`Result:`, res.data.result?.response || res.data);
    return true;
  } catch (err) {
    console.log('FAILURE');
    console.log(`Status Code: ${err.response?.status || 'N/A'}`);
    console.log(`Model Tested: ${model}`);
    console.log(`Response Body:`, JSON.stringify(err.response?.data, null, 2) || err.message);
    return false;
  }
}

async function run() {
  const oai = await testOpenAI();
  const cf = await testCloudflare();
  if (!oai || !cf) {
    console.log('\n❌ One or both models failed. Please check the logs above.');
    process.exit(1);
  } else {
    console.log('\n✅ All models verified successfully.');
    process.exit(0);
  }
}

run();
