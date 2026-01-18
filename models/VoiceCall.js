// models/VoiceCall.js - Voice Call Metadata Schema
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
      'RINGING',      // Call initiated, receiver notified
      'CONNECTING',   // Receiver accepted, joining channel
      'CONNECTED',    // Both users in channel, audio flowing
      'DECLINED',     // Receiver declined
      'TIMEOUT',      // No answer within 30 seconds
      'ENDED',        // Call ended normally
      'FAILED',       // Call failed due to error
      'EXPIRED'       // Auto-expired by system
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
    type: Number, // in seconds
    default: null
  },
  
  // ==================== END REASON ====================
  endReason: {
    type: String,
    enum: [
      'user_ended',           // User tapped end call
      'receiver_declined',    // Receiver declined
      'no_answer',           // Timeout
      'network_failure',     // Connection lost
      'max_duration_exceeded', // 2 hour limit
      'booking_expired',     // Meetup date passed
      'system_error',        // Internal error
      'auto_expired'         // Cleanup job
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
    callerPlatform: String, // 'android' or 'ios'
    receiverPlatform: String
  },
  
  // ==================== PRIVACY & COMPLIANCE ====================
  // NOTE: We store ONLY metadata, NEVER audio data
  audioRecorded: {
    type: Boolean,
    default: false,
    immutable: true // This should ALWAYS be false
  }
  
}, {
  timestamps: true // Adds createdAt and updatedAt
});

// ==================== INDEXES ====================
// Composite index for finding active calls by user
voiceCallSchema.index({ callerId: 1, status: 1 });
voiceCallSchema.index({ receiverId: 1, status: 1 });

// Index for finding calls by booking
voiceCallSchema.index({ bookingId: 1, createdAt: -1 });

// Index for cleanup jobs (finding old RINGING calls)
voiceCallSchema.index({ status: 1, initiatedAt: 1 });

// TTL Index - automatically delete call metadata after 30 days
voiceCallSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 } // 30 days
);

// ==================== VIRTUAL FIELDS ====================
voiceCallSchema.virtual('isActive').get(function() {
  return ['RINGING', 'CONNECTING', 'CONNECTED'].includes(this.status);
});

// ==================== METHODS ====================

/**
 * Check if call can still be accepted
 */
voiceCallSchema.methods.canBeAccepted = function() {
  if (this.status !== 'RINGING') return false;
  
  // Check if call has been ringing for more than 30 seconds
  const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
  if (this.initiatedAt < thirtySecondsAgo) return false;
  
  return true;
};

/**
 * Accept the call (update status and timestamp)
 */
voiceCallSchema.methods.accept = async function() {
  if (!this.canBeAccepted()) {
    throw new Error('Call can no longer be accepted');
  }
  
  this.status = 'CONNECTING';
  this.acceptedAt = new Date();
  
  return this.save();
};

/**
 * Mark call as connected
 */
voiceCallSchema.methods.connect = async function() {
  if (this.status !== 'CONNECTING') {
    throw new Error('Call must be in CONNECTING state');
  }
  
  this.status = 'CONNECTED';
  this.connectedAt = new Date();
  
  return this.save();
};

/**
 * End the call
 */
voiceCallSchema.methods.end = async function(reason = 'user_ended') {
  if (!this.isActive) {
    throw new Error('Call is not active');
  }
  
  this.status = 'ENDED';
  this.endedAt = new Date();
  this.endReason = reason;
  
  // Calculate duration if call was connected
  if (this.connectedAt) {
    this.duration = Math.floor((this.endedAt - this.connectedAt) / 1000);
  }
  
  return this.save();
};

/**
 * Decline the call
 */
voiceCallSchema.methods.decline = async function() {
  if (this.status !== 'RINGING') {
    throw new Error('Can only decline ringing calls');
  }
  
  this.status = 'DECLINED';
  this.endedAt = new Date();
  this.endReason = 'receiver_declined';
  
  return this.save();
};

/**
 * Mark call as failed
 */
voiceCallSchema.methods.fail = async function(reason) {
  this.status = 'FAILED';
  this.endedAt = new Date();
  this.endReason = 'system_error';
  this.failureReason = reason;
  
  return this.save();
};

// ==================== STATIC METHODS ====================

/**
 * Check if user is currently on a call
 */
voiceCallSchema.statics.isUserOnCall = async function(userId) {
  const activeCall = await this.findOne({
    $or: [
      { callerId: userId },
      { receiverId: userId }
    ],
    status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
  });
  
  return !!activeCall;
};

/**
 * Get user's active call
 */
voiceCallSchema.statics.getUserActiveCall = async function(userId) {
  return this.findOne({
    $or: [
      { callerId: userId },
      { receiverId: userId }
    ],
    status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
  });
};

/**
 * Count recent call attempts for rate limiting
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
 * Get call statistics for a booking
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
 * Cleanup stale calls (cron job helper)
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
 * Expire old connected calls (cron job helper)
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

// ==================== HOOKS ====================

/**
 * Pre-save validation
 */
voiceCallSchema.pre('save', function(next) {
  // Ensure audioRecorded is ALWAYS false (privacy guarantee)
  if (this.audioRecorded === true) {
    return next(new Error('Audio recording is not allowed'));
  }
  
  // Auto-calculate duration if ending call
  if (this.status === 'ENDED' && this.connectedAt && this.endedAt && !this.duration) {
    this.duration = Math.floor((this.endedAt - this.connectedAt) / 1000);
  }
  
  next();
});

/**
 * Post-save logging
 */
voiceCallSchema.post('save', function(doc) {
  // Log state transitions for debugging
  console.log(`VoiceCall ${doc._id}: ${doc.status}`);
});

// ==================== MODEL ====================
const VoiceCall = mongoose.model('VoiceCall', voiceCallSchema);

module.exports = VoiceCall;
