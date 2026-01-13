// backend/config/firebase.js - Environment Variables ONLY

const admin = require('firebase-admin');

/**
 * Initialize Firebase Admin SDK using ENVIRONMENT VARIABLES ONLY
 * 
 * REQUIRED ENVIRONMENT VARIABLES:
 * - FIREBASE_PROJECT_ID
 * - FIREBASE_CLIENT_EMAIL
 * - FIREBASE_PRIVATE_KEY
 * 
 * Add these to your .env file or deployment platform (Render, Vercel, etc.)
 */

if (!admin.apps.length) {
  try {
    // ✅ Validate environment variables exist
    if (!process.env.FIREBASE_PROJECT_ID || 
        !process.env.FIREBASE_CLIENT_EMAIL || 
        !process.env.FIREBASE_PRIVATE_KEY) {
      throw new Error('Missing required Firebase environment variables');
    }

    // ✅ Initialize with environment variables
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // ✅ IMPORTANT: Replace literal \n with actual newlines
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      }),
      projectId: process.env.FIREBASE_PROJECT_ID
    });
    
    console.log('✅ Firebase Admin SDK initialized successfully');
    console.log(`   Project: ${process.env.FIREBASE_PROJECT_ID}`);
    
  } catch (error) {
    console.error('❌ Firebase Admin initialization error:', error.message);
    console.log('');
    console.log('📋 REQUIRED ENVIRONMENT VARIABLES:');
    console.log('');
    console.log('FIREBASE_PROJECT_ID=your-project-id');
    console.log('FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com');
    console.log('FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nYOUR_KEY_HERE\\n-----END PRIVATE KEY-----\\n"');
    console.log('');
    console.log('⚠️  Make sure to wrap FIREBASE_PRIVATE_KEY in quotes and use \\n for newlines!');
    console.log('');
    
    // Don't crash the server, but notifications won't work
    console.log('⚠️  Server will continue, but FCM notifications are DISABLED');
  }
}

module.exports = admin;
