const mongoose = require('mongoose');
const founderController = require('./controllers/founderController');
const FounderMessage = require('./models/FounderMessage');
require('dotenv').config();

async function runTests() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/humrah');
  console.log('Connected to MongoDB.');

  const mockUserId = new mongoose.Types.ObjectId();

  const canonicalCategories = [
    'BUG_REPORT', 'FEATURE_IDEA', 'FEEDBACK', 'SAFETY_CONCERN', 
    'APPRECIATION', 'PARTNERSHIP', 'OTHER'
  ];

  const legacyOrInvalid = [
    'BUG', 'FEATURE_REQUEST', 'COMPLAINT', 'INVALID_CATEGORY'
  ];

  async function mockReqRes(category) {
    const req = {
      user: { _id: mockUserId, firstName: 'Test', email: 'test@example.com' },
      body: {
        category,
        message: 'Test message body for category: ' + category,
        replyPreference: 'NO_REPLY'
      }
    };
    
    let statusCode = 200;
    let jsonResponse = null;

    const res = {
      status: (code) => { statusCode = code; return res; },
      json: (data) => { jsonResponse = data; return res; }
    };

    return { req, res, getResult: () => ({ statusCode, jsonResponse }) };
  }

  console.log('\n--- TESTING CANONICAL CATEGORIES ---');
  for (const cat of canonicalCategories) {
    const { req, res, getResult } = await mockReqRes(cat);
    
    // Catch errors during execution
    try {
        await founderController.submitMessage(req, res);
    } catch (e) {
        console.log(`[FAIL] ${cat} -> Controller crashed: ${e.message}`);
        continue;
    }
    
    const result = getResult();
    
    if (result.statusCode === 201 || result.statusCode === 200) {
      console.log(`[PASS] ${cat} -> Successfully processed by controller (Status: ${result.statusCode})`);
    } else {
      console.log(`[FAIL] ${cat} -> Rejected by controller: ${JSON.stringify(result.jsonResponse)}`);
    }
  }

  console.log('\n--- TESTING LEGACY/INVALID CATEGORIES ---');
  for (const cat of legacyOrInvalid) {
    const { req, res, getResult } = await mockReqRes(cat);
    
    try {
        await founderController.submitMessage(req, res);
    } catch (e) {}

    const result = getResult();
    
    if (result.statusCode === 400 && result.jsonResponse && result.jsonResponse.message === 'Invalid category.') {
      console.log(`[PASS] ${cat} -> Correctly rejected with 'Invalid category.' (Status: ${result.statusCode})`);
    } else {
      console.log(`[FAIL] ${cat} -> Unexpected result: Status ${result.statusCode}, body: ${JSON.stringify(result.jsonResponse)}`);
    }
  }
  
  console.log('\n--- TESTING LEGACY READ/SCHEMA COMPATIBILITY ---');
  try {
      const doc = new FounderMessage({
          user: mockUserId,
          userSnapshot: { name: 'Test', email: 'test@test.com' },
          category: 'BUG', // legacy
          replyPreference: 'NO_REPLY',
          message: 'Historical bug report'
      });
      await doc.validate();
      console.log(`[PASS] Mongoose schema still accepts legacy 'BUG' value for historical records.`);
  } catch (err) {
      console.log(`[FAIL] Mongoose schema rejected legacy 'BUG':`, err.message);
  }

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
}

runTests().catch(console.error);
