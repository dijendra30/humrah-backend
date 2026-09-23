// scripts/migrateUserTypes.js - Migration Script to Set userType for Existing Users
const mongoose = require('mongoose');
const User = require('../models/User');

/**
 * Migration Script: Update userType field for all existing users
 * 
 * This script:
 * 1. Adds userType field to all users who don't have it
 * 2. Sets userType='COMPANION' if becomeCompanion="Yes, I'm interested"
 * 3. Sets userType='MEMBER' for everyone else
 * 4. Preserves admin roles (role field is separate from userType)
 */

async function migrateUserTypes() {
  try {
    console.log('🚀 Starting userType migration...\n');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/humrah', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log('✅ Connected to MongoDB\n');

    // Get all users
    const users = await User.find({});
    console.log(`📊 Found ${users.length} users to migrate\n`);

    let companionCount = 0;
    let memberCount = 0;
    let noChangeCount = 0;
    let errorCount = 0;

    // Process each user
    for (const user of users) {
      try {
        // Determine userType based on becomeCompanion answer
        let newUserType = 'MEMBER'; // Default
        
        if (user.questionnaire && user.questionnaire.becomeCompanion === "Yes, I'm interested") {
          newUserType = 'COMPANION';
        }

        // Check if already set correctly
        if (user.userType === newUserType) {
          noChangeCount++;
          continue;
        }

        // Update user
        user.userType = newUserType;
        await user.save();

        if (newUserType === 'COMPANION') {
          companionCount++;
          console.log(`✅ Set ${user.email} → COMPANION (role: ${user.role})`);
        } else {
          memberCount++;
          console.log(`✅ Set ${user.email} → MEMBER (role: ${user.role})`);
        }

      } catch (error) {
        errorCount++;
        console.error(`❌ Error updating ${user.email}:`, error.message);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 MIGRATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total users processed:     ${users.length}`);
    console.log(`✅ Set to COMPANION:       ${companionCount}`);
    console.log(`✅ Set to MEMBER:          ${memberCount}`);
    console.log(`ℹ️  No change needed:      ${noChangeCount}`);
    console.log(`❌ Errors:                 ${errorCount}`);
    console.log('='.repeat(60) + '\n');

    // Verification query
    const companionUsers = await User.countDocuments({ userType: 'COMPANION' });
    const memberUsers = await User.countDocuments({ userType: 'MEMBER' });

    console.log('✅ VERIFICATION:');
    console.log(`   Total COMPANION users: ${companionUsers}`);
    console.log(`   Total MEMBER users:    ${memberUsers}\n`);

    // Show sample of each type
    console.log('📋 SAMPLE COMPANIONS:');
    const sampleCompanions = await User.find({ userType: 'COMPANION' })
      .select('email role userType questionnaire.becomeCompanion')
      .limit(5);
    
    sampleCompanions.forEach(user => {
      console.log(`   - ${user.email} (role: ${user.role}, companion: ${user.questionnaire?.becomeCompanion})`);
    });

    console.log('\n📋 SAMPLE MEMBERS:');
    const sampleMembers = await User.find({ userType: 'MEMBER' })
      .select('email role userType questionnaire.becomeCompanion')
      .limit(5);
    
    sampleMembers.forEach(user => {
      console.log(`   - ${user.email} (role: ${user.role}, companion: ${user.questionnaire?.becomeCompanion || 'not set'})`);
    });

    console.log('\n✅ Migration completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
migrateUserTypes();
