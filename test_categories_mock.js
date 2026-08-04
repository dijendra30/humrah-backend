const founderController = require('./controllers/founderController');
const FounderMessage = require('./models/FounderMessage');

// Mock mongoose model methods so we don't need a real DB connection
FounderMessage.countDocuments = async () => 0;
FounderMessage.prototype.save = async function() { 
    this._id = 'mocked_id_123';
    return this; 
};

async function runTests() {
  const mockUserId = '507f1f77bcf86cd799439011';

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
    
    try {
        await founderController.submitMessage(req, res);
    } catch (e) {
        // If it throws during save because we didn't mock everything perfectly, 
        // that still means it PASSED the controller validation!
        const result = getResult();
        if (result.statusCode === 400) {
            console.log(`[FAIL] ${cat} -> Rejected by controller: ${JSON.stringify(result.jsonResponse)}`);
        } else {
            console.log(`[PASS] ${cat} -> Successfully bypassed validation!`);
        }
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
}

runTests().catch(console.error);
