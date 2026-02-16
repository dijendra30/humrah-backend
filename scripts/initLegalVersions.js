require('dotenv').config();
const mongoose = require('mongoose');

const legalVersionSchema = new mongoose.Schema({
  documentType: { type: String, enum: ['TERMS', 'PRIVACY'], required: true, unique: true },
  currentVersion: { type: String, required: true },
  url: { type: String, required: true },
  effectiveDate: { type: Date, required: true },
  previousVersions: [{ version: String, url: String, effectiveDate: Date, deprecatedAt: Date }],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changeNotes: { type: String }
}, { timestamps: true });

async function init() {
  try {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/humrah';
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected!\n');
    
    const LegalVersion = mongoose.model('LegalVersion', legalVersionSchema);
    
    const existingTerms = await LegalVersion.findOne({ documentType: 'TERMS' });
    if (!existingTerms) {
      await LegalVersion.create({
        documentType: 'TERMS',
        currentVersion: '1.0.0',
        url: 'https://humrah.in/terms.html',
        effectiveDate: new Date('2025-01-01'),
        changeNotes: 'Initial version'
      });
      console.log('✅ Terms of Service created (v1.0.0)');
    } else {
      console.log('ℹ️  Terms already exists (v' + existingTerms.currentVersion + ')');
    }
    
    const existingPrivacy = await LegalVersion.findOne({ documentType: 'PRIVACY' });
    if (!existingPrivacy) {
      await LegalVersion.create({
        documentType: 'PRIVACY',
        currentVersion: '1.0.0',
        url: 'https://humrah.in/privacy.html',
        effectiveDate: new Date('2025-01-01'),
        changeNotes: 'Initial version'
      });
      console.log('✅ Privacy Policy created (v1.0.0)');
    } else {
      console.log('ℹ️  Privacy already exists (v' + existingPrivacy.currentVersion + ')');
    }
    
    console.log('\n✅ DONE! Your database is ready.');
    console.log('\n📋 Next Steps:');
    console.log('1. Make sure https://humrah.in/terms.html exists');
    console.log('2. Make sure https://humrah.in/privacy.html exists');
    console.log('3. Try registering again in your Android app');
    
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('\nTroubleshooting:');
    console.error('- Check your MONGODB_URI in .env');
    console.error('- Make sure MongoDB is running');
    process.exit(1);
  }
}

console.log('🚀 Initializing Legal Versions...\n');
init();
