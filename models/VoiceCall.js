// models/VoiceCall.js - COMPLETE FIXED VERSION
const mongoose = require('mongoose');

const voiceCallSchema = new mongoose.Schema({
  // ==================== CALL PARTICIPANTS ====================
  callerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  receiverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // ==================== BOOKING REFERENCE ====================
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RandomBooking',
    required: true,
    index: true
  },
  
  // ==================== AGORA DETAILS ====================
  channelName: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  callerAgoraUid: {
    type: Number,
    required: true
  },
  
  receiverAgoraUid: {
    type: Number,
    default: null
  },
  
  // ==================== CALL STATUS ====================
  status: {
    type: String,
    enum: [
      'RINGING',
      'CONNECTING',
      'CONNECTED',
      'DECLINED',
      'TIMEOUT',
      'ENDED',
      'FAILED',
      'EXPIRED'
    ],
    default: 'RINGING',
    required: true,
    index: true
  },
  
  // ==================== TIMESTAMPS ====================
  initiatedAt: {
    type: Date,
    default: Date.now,
    required: true,
    index: true
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
  
  // ==================== DURATION ====================
  duration: {
    type: Number,
    default: null
  },
  
  // ==================== END REASON ====================
  endReason: {
    type: String,
    enum: [
      'user_ended',
      'receiver_declined',
      'no_answer',
      'network_failure',
      'max_duration_exceeded',
      'booking_expired',
      'system_error',
      'auto_expired',
      'auto_timeout',
      'stale_cleanup'
    ],
    default: null
  },
  
  // ==================== FAILURE DETAILS ====================
  failureReason: {
    type: String,
    default: null
  },
  
  // ==================== NETWORK QUALITY ====================
  networkQuality: {
    caller: {
      type: String,
      enum: ['excellent', 'good', 'fair', 'poor', 'unknown'],
      default: 'unknown'
    },
    receiver: {
      type: String,
      enum: ['excellent', 'good', 'fair', 'poor', 'unknown'],
      default: 'unknown'
    }
  },
  
  // ==================== CLIENT INFO ====================
  clientInfo: {
    callerAppVersion: String,
    receiverAppVersion: String,
    callerPlatform: String,
    receiverPlatform: String
  },
  
  // ==================== PRIVACY & COMPLIANCE ====================
  audioRecorded: {
    type: Boolean,
    default: false,
    immutable: true
  }
  
}, {
  timestamps: true
});

// ==================== INDEXES ====================
voiceCallSchema.index({ callerId: 1, status: 1 });
voiceCallSchema.index({ receiverId: 1, status: 1 });
voiceCallSchema.index({ bookingId: 1, createdAt: -1 });
voiceCallSchema.index({ status: 1, initiatedAt: 1 });
voiceCallSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 }
);

// ==================== VIRTUAL FIELDS ====================
voiceCallSchema.virtual('isActive').get(function() {
  return ['RINGING', 'CONNECTING', 'CONNECTED'].includes(this.status);
});

// ==================== INSTANCE METHODS ====================

voiceCallSchema.methods.canBeAccepted = function() {
  if (this.status !== 'RINGING') return false;
  
  const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
  if (this.initiatedAt < thirtySecondsAgo) return false;
  
  return true;
};

voiceCallSchema.methods.accept = async function() {
  if (!this.canBeAccepted()) {
    throw new Error('Call can no longer be accepted');
  }
  
  this.status = 'CONNECTING';
  this.acceptedAt = new Date();
  
  return this.save();
};

voiceCallSchema.methods.connect = async function() {
  if (this.status !== 'CONNECTING') {
    throw new Error('Call must be in CONNECTING state');
  }
  
  this.status = 'CONNECTED';
  this.connectedAt = new Date();
  
  return this.save();
};

voiceCallSchema.methods.end = async function(reason = 'user_ended') {
  if (!this.isActive) {
    throw new Error('Call is not active');
  }
  
  this.status = 'ENDED';
  this.endedAt = new Date();
  this.endReason = reason;
  
  if (this.connectedAt) {
    this.duration = Math.floor((this.endedAt - this.connectedAt) / 1000);
  }
  
  return this.save();
};

voiceCallSchema.methods.decline = async function() {
  if (this.status !== 'RINGING') {
    throw new Error('Can only decline ringing calls');
  }
  
  this.status = 'DECLINED';
  this.endedAt = new Date();
  this.endReason = 'receiver_declined';
  
  return this.save();
};

voiceCallSchema.methods.fail = async function(reason) {
  this.status = 'FAILED';
  this.endedAt = new Date();
  this.endReason = 'system_error';
  this.failureReason = reason;
  
  return this.save();
};

// ==================== STATIC METHODS ====================

/**
 * ✅ CRITICAL FIX: Check if user is on call WITH AUTO-CLEANUP
 * Threshold reduced from 5 minutes to 2 minutes
 */
voiceCallSchema.statics.isUserOnCall = async function(userId) {
  console.log(`\n🔍 Checking if user ${userId} is on call...`);
  
  // ✅ CRITICAL FIX: 2-minute stale threshold (was 5 minutes)
  const STALE_THRESHOLD = 2 * 60 * 1000; // 2 minutes
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
 * ✅ FIXED: Get user's active call WITH AUTO-CLEANUP
 * Threshold reduced from 5 minutes to 2 minutes
 */
voiceCallSchema.statics.getUserActiveCall = async function(userId) {
  // Auto-cleanup stale calls first
  const STALE_THRESHOLD = 2 * 60 * 1000; // 2 minutes (was 5)
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
 * Count recent call attempts
 */
voiceCallSchema.statics.countRecentAttempts = async function(callerId, bookingId, hours = 1) {
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  return this.countDocuments({
    callerId,
    bookingId,
    createdAt: { $gte: cutoffTime }
  });
};

/**
 * Get call statistics
 */
voiceCallSchema.statics.getBookingCallStats = async function(bookingId) {
  const calls = await this.find({ bookingId });
  
  return {
    total: calls.length,
    connected: calls.filter(c => c.status === 'CONNECTED' || c.status === 'ENDED').length,
    declined: calls.filter(c => c.status === 'DECLINED').length,
    timeout: calls.filter(c => c.status === 'TIMEOUT').length,
    failed: calls.filter(c => c.status === 'FAILED').length,
    totalDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0)
  };
};

/**
 * ✅ Cleanup stale RINGING calls (cron job)
 */
voiceCallSchema.statics.cleanupStaleCalls = async function() {
  const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
  
  const result = await this.updateMany(
    {
      status: 'RINGING',
      initiatedAt: { $lt: thirtySecondsAgo }
    },
    {
      $set: {
        status: 'TIMEOUT',
        endedAt: new Date(),
        endReason: 'no_answer'
      }
    }
  );
  
  return result.modifiedCount;
};

/**
 * ✅ Expire long CONNECTED calls (cron job)
 */
voiceCallSchema.statics.expireConnectedCalls = async function() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  
  const result = await this.updateMany(
    {
      status: 'CONNECTED',
      connectedAt: { $lt: twoHoursAgo }
    },
    {
      $set: {
        status: 'ENDED',
        endedAt: new Date(),
        endReason: 'max_duration_exceeded'
      }
    }
  );
  
  return result.modifiedCount;
};

/**
 * ✅ NEW: Global cleanup of all stale calls
 */
voiceCallSchema.statics.cleanupAllStaleCalls = async function(thresholdMinutes = 2) {
  const staleTime = new Date(Date.now() - thresholdMinutes * 60 * 1000);
  
  console.log('🧹 Running global stale call cleanup...');
  
  const result = await this.updateMany(
    {
      status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] },
      initiatedAt: { $lt: staleTime }
    },
    {
      $set: {
        status: 'ENDED',
        endedAt: new Date(),
        endReason: 'stale_cleanup'
      }
    }
  );
  
  console.log(`✅ Cleaned up ${result.modifiedCount} stale calls`);
  
  return result;
};

// ==================== HOOKS ====================

voiceCallSchema.pre('save', function(next) {
  if (this.audioRecorded === true) {
    return next(new Error('Audio recording is not allowed'));
  }
  
  if (this.status === 'ENDED' && this.connectedAt && this.endedAt && !this.duration) {
    this.duration = Math.floor((this.endedAt - this.connectedAt) / 1000);
  }
  
  next();
});

voiceCallSchema.post('save', function(doc) {
  console.log(`VoiceCall ${doc._id}: ${doc.status}`);
});

// ==================== EXPORT ====================
const VoiceCall = mongoose.model('VoiceCall', voiceCallSchema);

module.exports = VoiceCall;
