// backend/config/firebase.js - FIXED with Proper Key Parsing

const admin = require('firebase-admin');

/**
 * Initialize Firebase Admin SDK using ENVIRONMENT VARIABLES
 * 
 * REQUIRED ENVIRONMENT VARIABLES:
 * - FIREBASE_PROJECT_ID
 * - FIREBASE_CLIENT_EMAIL
 * - FIREBASE_PRIVATE_KEY
 */

if (!admin.apps.length) {
  try {
    // ✅ Validate environment variables exist
    if (!process.env.FIREBASE_PROJECT_ID || 
        !process.env.FIREBASE_CLIENT_EMAIL || 
        !process.env.FIREBASE_PRIVATE_KEY) {
      throw new Error('Missing required Firebase environment variables');
    }

    // ✅ CRITICAL FIX: Properly parse the private key
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    
    // Remove any quotes that might be wrapping the key
    privateKey = privateKey.replace(/^["']|["']$/g, '');
    
    // Replace literal \n with actual newlines
    privateKey = privateKey.replace(/\\n/g, '\n');
    
    // Debug log (first and last 50 chars only)
    console.log('🔐 Firebase Private Key Check:');
    console.log('   Starts with:', privateKey.substring(0, 50));
    console.log('   Ends with:', privateKey.substring(privateKey.length - 50));
    console.log('   Contains newlines:', privateKey.includes('\n'));
    console.log('   Total length:', privateKey.length);

    // ✅ Initialize with properly formatted credentials
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey  // ✅ Use the cleaned key
      }),
      projectId: process.env.FIREBASE_PROJECT_ID
    });
    
    console.log('✅ Firebase Admin SDK initialized successfully');
    console.log(`   Project: ${process.env.FIREBASE_PROJECT_ID}`);
    console.log(`   Client: ${process.env.FIREBASE_CLIENT_EMAIL}`);
    
  } catch (error) {
    console.error('❌ Firebase Admin initialization error:', error.message);
    console.log('');
    console.log('📋 TROUBLESHOOTING:');
    console.log('');
    
    if (error.message.includes('secretOrPrivateKey') || error.message.includes('RS256')) {
      console.log('⚠️  PRIVATE KEY FORMAT ERROR');
      console.log('   Your FIREBASE_PRIVATE_KEY is not formatted correctly.');
      console.log('');
      console.log('   CORRECT FORMAT in .env:');
      console.log('   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgk...\\n-----END PRIVATE KEY-----\\n"');
      console.log('');
      console.log('   IMPORTANT:');
      console.log('   1. Wrap the entire key in double quotes');
      console.log('   2. Use \\n (backslash-n) for newlines, NOT actual newlines');
      console.log('   3. Copy EXACTLY from the service account JSON');
      console.log('');
    }
    
    console.log('REQUIRED ENVIRONMENT VARIABLES:');
    console.log('');
    console.log('FIREBASE_PROJECT_ID=your-project-id');
    console.log('FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com');
    console.log('FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nYOUR_KEY_HERE\\n-----END PRIVATE KEY-----\\n"');
    console.log('');
    
    // ⚠️ Don't crash the server, but notifications won't work
    console.log('⚠️  Server will continue, but FCM notifications are DISABLED');
    console.log('');
  }
}

module.exports = admin;
