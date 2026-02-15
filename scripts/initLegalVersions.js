// scripts/initLegalVersions.js
// FULL FILE - CREATE NEW
// RUN THIS ONCE TO INITIALIZE LEGAL VERSIONS IN DATABASE
// Usage: node scripts/initLegalVersions.js

require('dotenv').config();
const mongoose = require('mongoose');
const LegalVersion = require('../models/LegalVersion');

async function initializeLegalVersions() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/humrah');
    
    console.log('✅ Connected to MongoDB');
    console.log('Initializing legal versions...');
    
    // Check if already initialized
    const existingTerms = await LegalVersion.findOne({ documentType: 'TERMS' });
    const existingPrivacy = await LegalVersion.findOne({ documentType: 'PRIVACY' });
    
    if (!existingTerms) {
      const terms = new LegalVersion({
        documentType: 'TERMS',
        currentVersion: '1.0.0',
        url: 'https://humrah.com/terms.html',
        effectiveDate: new Date('2025-01-01'),
        changeNotes: 'Initial version'
      });
      
      await terms.save();
      console.log('✅ Terms of Service initialized (v1.0.0)');
    } else {
      console.log('ℹ️  Terms of Service already exists (v' + existingTerms.currentVersion + ')');
    }
    
    if (!existingPrivacy) {
      const privacy = new LegalVersion({
        documentType: 'PRIVACY',
        currentVersion: '1.0.0',
        url: 'https://humrah.com/privacy.html',
        effectiveDate: new Date('2025-01-01'),
        changeNotes: 'Initial version'
      });
      
      await privacy.save();
      console.log('✅ Privacy Policy initialized (v1.0.0)');
    } else {
      console.log('ℹ️  Privacy Policy already exists (v' + existingPrivacy.currentVersion + ')');
    }
    
    console.log('\n✅ Legal versions initialization complete!');
    console.log('\nNext steps:');
    console.log('1. Update URLs in MongoDB if needed (currently pointing to https://humrah.com/terms.html and privacy.html)');
    console.log('2. Host your terms.html and privacy.html files at those URLs');
    console.log('3. Test the registration flow in your Android app');
    console.log('4. Check MongoDB for LegalAcceptance records after registration');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    console.error('\nTroubleshooting:');
    console.error('- Check your MONGODB_URI in .env file');
    console.error('- Make sure MongoDB is running');
    console.error('- Verify models/LegalVersion.js exists');
    process.exit(1);
  }
}

initializeLegalVersions();
