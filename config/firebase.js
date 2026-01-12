// backend/config/firebase.js - Firebase Admin SDK Configuration

const admin = require('firebase-admin');
const path = require('path');

/**
 * Initialize Firebase Admin SDK (only once)
 * 
 * SETUP INSTRUCTIONS:
 * 1. Go to Firebase Console: https://console.firebase.google.com/
 * 2. Select project: "humrah-d926d"
 * 3. Click Settings (⚙️) > Project Settings
 * 4. Go to "Service Accounts" tab
 * 5. Click "Generate new private key"
 * 6. Download the JSON file
 * 7. Save as: backend/config/firebase-service-account.json
 * 8. Add to .gitignore: config/firebase-service-account.json
 * 
 * IMPORTANT: Never commit service account keys to Git!
 */

if (!admin.apps.length) {
  try {
    // ✅ OPTION 1: Using service account JSON file (RECOMMENDED for development)
    const serviceAccount = require(path.join(__dirname, 'firebase-service-account.json'));
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: 'humrah-d926d' // Your Firebase project ID
    });
    
    console.log('✅ Firebase Admin SDK initialized successfully');
    
  } catch (error) {
    console.error('❌ Firebase Admin initialization error:', error.message);
    console.log('⚠️  Attempting to initialize with environment variables...');
    
    try {
      // ✅ OPTION 2: Using environment variables (RECOMMENDED for production)
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        }),
        projectId: process.env.FIREBASE_PROJECT_ID
      });
      
      console.log('✅ Firebase Admin SDK initialized with environment variables');
      
    } catch (envError) {
      console.error('❌ Firebase Admin initialization with env vars failed:', envError.message);
      console.log('');
      console.log('📋 SETUP REQUIRED:');
      console.log('1. Download service account key from Firebase Console');
      console.log('2. Save as: backend/config/firebase-service-account.json');
      console.log('OR');
      console.log('3. Set environment variables:');
      console.log('   - FIREBASE_PROJECT_ID');
      console.log('   - FIREBASE_CLIENT_EMAIL');
      console.log('   - FIREBASE_PRIVATE_KEY');
      console.log('');
    }
  }
}

module.exports = admin;
