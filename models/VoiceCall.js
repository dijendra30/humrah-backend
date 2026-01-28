// models/VoiceCall.js - FIXED VERSION WITH PROPER CLEANUP
const mongoose = require('mongoose');

const VoiceCallSchema = new mongoose.Schema({
  callerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  receiverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RandomBooking',
    required: true
  },
  channelName: {
    type: String,
    required: true
  },
  callerAgoraUid: {
    type: Number,
    required: true
  },
  receiverAgoraUid: {
    type: Number,
    default: null
  },
  status: {
    type: String,
    enum: ['RINGING', 'CONNECTING', 'CONNECTED', 'ENDED', 'DECLINED', 'MISSED', 'FAILED'],
    default: 'RINGING'
  },
  initiatedAt: {
    type: Date,
    default: Date.now
  },
  acceptedAt: {
    type: Date,
    default: null
  },
  connectedAt: {
    type: Date,
    default: null
  },
  endedAt: {
    type: Date,
    default: null
  },
  duration: {
    type: Number, // in seconds
    default: 0
  },
  endReason: {
    type: String,
    default: null
  },
  isDeleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// ==================== INDEXES ====================
VoiceCallSchema.index({ callerId: 1, status: 1 });
VoiceCallSchema.index({ receiverId: 1, status: 1 });
VoiceCallSchema.index({ bookingId: 1 });
VoiceCallSchema.index({ status: 1, initiatedAt: 1 });
VoiceCallSchema.index({ createdAt: 1 }); // For cleanup job

// ==================== VIRTUALS ====================
VoiceCallSchema.virtual('isActive').get(function() {
  return ['RINGING', 'CONNECTING', 'CONNECTED'].includes(this.status);
});

// ==================== INSTANCE METHODS ====================

/**
 * ✅ Check if call has timed out
 */
VoiceCallSchema.methods.hasTimedOut = function() {
  const now = new Date();
  
  // RINGING calls timeout after 30 seconds
  if (this.status === 'RINGING') {
    const ringingDuration = (now - this.initiatedAt) / 1000; // in seconds
    return ringingDuration > 30;
  }
  
  // CONNECTING calls timeout after 60 seconds
  if (this.status === 'CONNECTING') {
    const connectingDuration = (now - (this.acceptedAt || this.initiatedAt)) / 1000;
    return connectingDuration > 60;
  }
  
  // CONNECTED calls timeout after 30 minutes
  if (this.status === 'CONNECTED') {
    const connectedDuration = (now - this.connectedAt) / 1000;
    return connectedDuration > 1800; // 30 minutes
  }
  
  return false;
};

/**
 * ✅ Check if call can be accepted
 */
VoiceCallSchema.methods.canBeAccepted = function() {
  if (this.status !== 'RINGING') return false;
  if (this.hasTimedOut()) return false;
  return true;
};

/**
 * ✅ Decline call
 */
VoiceCallSchema.methods.decline = async function() {
  this.status = 'DECLINED';
  this.endedAt = new Date();
  this.duration = 0;
  this.endReason = 'declined';
  await this.save();
};

/**
 * ✅ End call
 */
VoiceCallSchema.methods.end = async function(reason = 'user_ended') {
  // Only end if call is active
  if (!this.isActive) {
    console.log(`⚠️ Call ${this._id} is not active (${this.status}), cannot end`);
    return;
  }
  
  this.status = 'ENDED';
  this.endedAt = new Date();
  this.endReason = reason;
  
  // Calculate duration only if call was connected
  if (this.connectedAt) {
    this.duration = Math.floor((this.endedAt - this.connectedAt) / 1000);
  } else {
    this.duration = 0;
  }
  
  await this.save();
  
  console.log(`✅ Call ${this._id} ended: ${reason} (duration: ${this.duration}s)`);
};

/**
 * ✅ Mark as missed
 */
VoiceCallSchema.methods.markAsMissed = async function() {
  if (this.status !== 'RINGING') return;
  
  this.status = 'MISSED';
  this.endedAt = new Date();
  this.duration = 0;
  this.endReason = 'timeout';
  await this.save();
  
  console.log(`⏰ Call ${this._id} marked as missed (timeout)`);
};

// ==================== STATIC METHODS ====================

/**
 * ✅ CRITICAL FIX: Check if user is on an ACTIVE call (with timeout cleanup)
 */

voiceCallSchema.statics.isUserOnCall = async function(userId) {
  console.log(`\n🔍 Checking if user ${userId} is on call...`);
  
  // ✅ CRITICAL FIX: Auto-cleanup stale calls BEFORE checking
  const STALE_THRESHOLD = 2 * 60 * 1000; // 2 minutes (reduced from 5)
  const staleTime = new Date(Date.now() - STALE_THRESHOLD);
  
  console.log(`   Stale threshold: ${new Date(staleTime).toISOString()}`);
  
  // Find all potentially active calls for this user
  const potentialCalls = await this.find({
    $or: [
      { callerId: userId },
      { receiverId: userId }
    ],
    status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
  }).select('_id status initiatedAt acceptedAt connectedAt');
  
  console.log(`   Found ${potentialCalls.length} potentially active call(s)`);
  
  if (potentialCalls.length === 0) {
    console.log(`   ✅ User is NOT on any call`);
    return false;
  }
  
  // Check each call for staleness
  let hasActiveCall = false;
  const now = new Date();
  
  for (const call of potentialCalls) {
    const age = (now - call.initiatedAt) / 1000; // seconds
    const isStale = call.initiatedAt < staleTime;
    
    console.log(`   Call ${call._id}:`);
    console.log(`      Status: ${call.status}`);
    console.log(`      Age: ${Math.floor(age)}s`);
    console.log(`      Stale: ${isStale}`);
    
    if (isStale) {
      // Auto-cleanup this stale call
      console.log(`      🧹 Auto-cleaning stale call...`);
      
      await this.updateOne(
        { _id: call._id },
        {
          $set: {
            status: 'ENDED',
            endedAt: new Date(),
            endReason: 'auto_timeout'
          }
        }
      );
    } else {
      // Call is still fresh
      hasActiveCall = true;
      console.log(`      ✅ Call is active`);
    }
  }
  
  if (hasActiveCall) {
    console.log(`   ❌ User IS on an active call`);
  } else {
    console.log(`   ✅ All calls were stale - User is FREE`);
  }
  
  return hasActiveCall;
};
/**
 * ✅ Get user's active call (if any)
 */
voiceCallSchema.statics.getUserActiveCall = async function(userId) {
  // Auto-cleanup stale calls first
  const STALE_THRESHOLD = 2 * 60 * 1000; // 2 minutes
  const staleTime = new Date(Date.now() - STALE_THRESHOLD);
  
  await this.updateMany(
    {
      $or: [
        { callerId: userId },
        { receiverId: userId }
      ],
      status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] },
      initiatedAt: { $lt: staleTime }
    },
    {
      $set: {
        status: 'ENDED',
        endedAt: new Date(),
        endReason: 'auto_timeout'
      }
    }
  );
  
  // Then find active call
  return this.findOne({
    $or: [
      { callerId: userId },
      { receiverId: userId }
    ],
    status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
  });
};

/**
 * ✅ Cleanup abandoned calls (cron job)
 */
VoiceCallSchema.statics.cleanupAbandonedCalls = async function() {
  console.log('\n🧹 CLEANUP JOB: Checking for abandoned calls...');
  
  const now = new Date();
  const thirtySecondsAgo = new Date(now - 30 * 1000);
  const sixtySecondsAgo = new Date(now - 60 * 1000);
  const thirtyMinutesAgo = new Date(now - 30 * 60 * 1000);
  
  // Find timed-out RINGING calls (>30s)
  const ringingCalls = await this.find({
    status: 'RINGING',
    initiatedAt: { $lt: thirtySecondsAgo },
    isDeleted: false
  });
  
  // Find timed-out CONNECTING calls (>60s)
  const connectingCalls = await this.find({
    status: 'CONNECTING',
    acceptedAt: { $lt: sixtySecondsAgo },
    isDeleted: false
  });
  
  // Find timed-out CONNECTED calls (>30min)
  const connectedCalls = await this.find({
    status: 'CONNECTED',
    connectedAt: { $lt: thirtyMinutesAgo },
    isDeleted: false
  });
  
  let cleanedCount = 0;
  
  // Cleanup RINGING calls
  for (const call of ringingCalls) {
    await call.markAsMissed();
    cleanedCount++;
  }
  
  // Cleanup CONNECTING calls
  for (const call of connectingCalls) {
    await call.end('timeout');
    cleanedCount++;
  }
  
  // Cleanup CONNECTED calls
  for (const call of connectedCalls) {
    await call.end('max_duration_reached');
    cleanedCount++;
  }
  
  if (cleanedCount > 0) {
    console.log(`✅ Cleaned up ${cleanedCount} abandoned call(s)`);
  } else {
    console.log(`✅ No abandoned calls found`);
  }
  
  return cleanedCount;
};

/**
 * ✅ Get call history for a booking
 */
VoiceCallSchema.statics.getBookingCallHistory = async function(bookingId) {
  return this.find({
    bookingId,
    isDeleted: false
  })
  .sort({ createdAt: -1 })
  .populate('callerId', 'firstName lastName profilePhoto')
  .populate('receiverId', 'firstName lastName profilePhoto');
};

// ==================== MIDDLEWARE ====================

// Auto-cleanup on save
VoiceCallSchema.pre('save', function(next) {
  // If marking as ended/declined/missed, ensure endedAt is set
  if (['ENDED', 'DECLINED', 'MISSED', 'FAILED'].includes(this.status) && !this.endedAt) {
    this.endedAt = new Date();
  }
  next();
});

const VoiceCall = mongoose.model('VoiceCall', VoiceCallSchema);

module.exports = VoiceCall;
