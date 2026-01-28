// scripts/cleanup-stale-calls.js - RUN THIS IMMEDIATELY
// ✅ This will fix the current "BUSY" error by cleaning up all stale calls

const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'your_mongodb_uri_here')
  .then(() => {
    console.log('✅ Connected to MongoDB');
    return cleanupStaleCalls();
  })
  .then(() => {
    console.log('\n✅ CLEANUP COMPLETE');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

async function cleanupStaleCalls() {
  console.log('\n🧹 STARTING STALE CALL CLEANUP');
  console.log('='.repeat(50));
  
  const VoiceCall = mongoose.model('VoiceCall', new mongoose.Schema({}, { strict: false }));
  
  // ==================== STEP 1: CHECK CURRENT STATE ====================
  console.log('\n📊 STEP 1: Analyzing current calls...');
  
  const activeCalls = await VoiceCall.find({
    status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
  }).select('status initiatedAt callerId receiverId acceptedAt connectedAt');
  
  console.log(`   Found ${activeCalls.length} active call(s)`);
  
  if (activeCalls.length === 0) {
    console.log('   ✅ No active calls found - database is clean!');
    return;
  }
  
  // Show details of active calls
  const now = new Date();
  console.log('\n   Call Details:');
  activeCalls.forEach((call, index) => {
    const ageMinutes = Math.floor((now - call.initiatedAt) / 1000 / 60);
    console.log(`   ${index + 1}. ID: ${call._id}`);
    console.log(`      Status: ${call.status}`);
    console.log(`      Age: ${ageMinutes} minutes`);
    console.log(`      Caller: ${call.callerId}`);
    console.log(`      Receiver: ${call.receiverId}`);
  });
  
  // ==================== STEP 2: CLEANUP STRATEGY ====================
  console.log('\n🔧 STEP 2: Cleanup Strategy');
  
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  
  const staleRinging = activeCalls.filter(c => 
    c.status === 'RINGING' && c.initiatedAt < fiveMinutesAgo
  );
  
  const staleConnecting = activeCalls.filter(c => 
    c.status === 'CONNECTING' && c.initiatedAt < fiveMinutesAgo
  );
  
  const staleConnected = activeCalls.filter(c => 
    c.status === 'CONNECTED' && c.initiatedAt < fiveMinutesAgo
  );
  
  console.log(`   Stale RINGING: ${staleRinging.length}`);
  console.log(`   Stale CONNECTING: ${staleConnecting.length}`);
  console.log(`   Stale CONNECTED: ${staleConnected.length}`);
  console.log(`   Total to clean: ${staleRinging.length + staleConnecting.length + staleConnected.length}`);
  
  // ==================== STEP 3: EXECUTE CLEANUP ====================
  console.log('\n🧹 STEP 3: Executing cleanup...');
  
  const result = await VoiceCall.updateMany(
    {
      status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] },
      initiatedAt: { $lt: fiveMinutesAgo }
    },
    {
      $set: {
        status: 'ENDED',
        endedAt: new Date(),
        endReason: 'stale_cleanup'
      }
    }
  );
  
  console.log(`   ✅ Cleaned up ${result.modifiedCount} stale call(s)`);
  
  // ==================== STEP 4: VERIFY CLEANUP ====================
  console.log('\n✔️ STEP 4: Verifying cleanup...');
  
  const remainingActive = await VoiceCall.countDocuments({
    status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
  });
  
  console.log(`   Remaining active calls: ${remainingActive}`);
  
  if (remainingActive === 0) {
    console.log('   ✅ All stale calls cleaned successfully!');
  } else {
    console.log('   ⚠️ Some active calls remain (likely genuine ongoing calls)');
    
    const remaining = await VoiceCall.find({
      status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
    }).select('status initiatedAt');
    
    remaining.forEach((call, index) => {
      const ageSeconds = Math.floor((now - call.initiatedAt) / 1000);
      console.log(`   ${index + 1}. ${call.status} - ${ageSeconds}s old`);
    });
  }
  
  // ==================== STEP 5: USER-SPECIFIC REPORT ====================
  console.log('\n👥 STEP 5: User Call Status Report');
  
  const userCallCounts = await VoiceCall.aggregate([
    {
      $match: {
        status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
      }
    },
    {
      $group: {
        _id: null,
        callers: { $addToSet: '$callerId' },
        receivers: { $addToSet: '$receiverId' }
      }
    }
  ]);
  
  if (userCallCounts.length > 0) {
    const allUsers = new Set([
      ...userCallCounts[0].callers.map(id => id.toString()),
      ...userCallCounts[0].receivers.map(id => id.toString())
    ]);
    
    console.log(`   ${allUsers.size} user(s) with active calls`);
    
    for (const userId of allUsers) {
      const userCalls = await VoiceCall.countDocuments({
        $or: [
          { callerId: mongoose.Types.ObjectId(userId) },
          { receiverId: mongoose.Types.ObjectId(userId) }
        ],
        status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
      });
      
      if (userCalls > 0) {
        console.log(`   ⚠️ User ${userId}: ${userCalls} active call(s)`);
      }
    }
  } else {
    console.log('   ✅ No users have active calls');
  }
  
  // ==================== SUMMARY ====================
  console.log('\n' + '='.repeat(50));
  console.log('📋 CLEANUP SUMMARY');
  console.log('='.repeat(50));
  console.log(`Total calls cleaned: ${result.modifiedCount}`);
  console.log(`Remaining active calls: ${remainingActive}`);
  console.log('Status: ' + (remainingActive === 0 ? '✅ SUCCESS' : '⚠️ PARTIAL'));
  console.log('='.repeat(50));
}
