// models/VoiceCall.js - COMPLETE FIXED VERSION
const mongoose = require('mongoose');

const voiceCallSchema = new mongoose.Schema({
  // ==================== CALL PARTICIPANTS ====================
  callerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    // ✅ FIX: index:true removed — covered by compound index({ callerId, status }) below
  },

  receiverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    // ✅ FIX: index:true removed — covered by compound index({ receiverId, status }) below
  },

  // ==================== BOOKING REFERENCE ====================
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RandomBooking',
    required: true,
    // ✅ FIX: index:true removed — covered by compound index({ bookingId, createdAt }) below
  },

  // ==================== AGORA DETAILS ====================
  channelName: {
    type: String,
    required: true,
    unique: true,
    // ✅ FIX: index:true removed — unique:true already creates an index automatically
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
    // ✅ FIX: index:true removed — covered by compound indexes({ callerId,status } and { receiverId,status }) below
  },

  // ==================== TIMESTAMPS ====================
  initiatedAt: {
    type: Date,
    default: Date.now,
    required: true,
    // ✅ FIX: index:true removed — covered by compound index({ status, initiatedAt }) below
  },

  acceptedAt:  { type: Date, default: null },
  connectedAt: { type: Date, default: null },
  endedAt:     { type: Date, default: null },

  // ==================== DURATION ====================
  duration: { type: Number, default: null },

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
  failureReason: { type: String, default: null },

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
    callerAppVersion:   String,
    receiverAppVersion: String,
    callerPlatform:     String,
    receiverPlatform:   String
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

// ==================== INDEXES — single source of truth ====================
voiceCallSchema.index({ callerId: 1, status: 1 });
voiceCallSchema.index({ receiverId: 1, status: 1 });
voiceCallSchema.index({ bookingId: 1, createdAt: -1 });
voiceCallSchema.index({ status: 1, initiatedAt: 1 });
voiceCallSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 }   // TTL: auto-delete after 30 days
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
  if (!this.canBeAccepted()) throw new Error('Call can no longer be accepted');
  this.status = 'CONNECTING';
  this.acceptedAt = new Date();
  return this.save();
};

voiceCallSchema.methods.connect = async function() {
  if (this.status !== 'CONNECTING') throw new Error('Call must be in CONNECTING state');
  this.status = 'CONNECTED';
  this.connectedAt = new Date();
  return this.save();
};

voiceCallSchema.methods.end = async function(reason = 'user_ended') {
  if (!this.isActive) throw new Error('Call is not active');
  this.status = 'ENDED';
  this.endedAt = new Date();
  this.endReason = reason;
  if (this.connectedAt) {
    this.duration = Math.floor((this.endedAt - this.connectedAt) / 1000);
  }
  return this.save();
};

voiceCallSchema.methods.decline = async function() {
  if (this.status !== 'RINGING') throw new Error('Can only decline ringing calls');
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

voiceCallSchema.statics.isUserOnCall = async function(userId) {
  console.log(`\n🔍 Checking if user ${userId} is on call...`);

  const STALE_THRESHOLD = 2 * 60 * 1000; // 2 minutes
  const staleTime = new Date(Date.now() - STALE_THRESHOLD);

  const potentialCalls = await this.find({
    $or: [{ callerId: userId }, { receiverId: userId }],
    status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
  }).select('_id status initiatedAt acceptedAt connectedAt');

  if (potentialCalls.length === 0) {
    console.log(`   ✅ User is NOT on any call`);
    return false;
  }

  let hasActiveCall = false;
  const now = new Date();

  for (const call of potentialCalls) {
    const isStale = call.initiatedAt < staleTime;
    if (isStale) {
      await this.updateOne(
        { _id: call._id },
        { $set: { status: 'ENDED', endedAt: new Date(), endReason: 'auto_timeout' } }
      );
    } else {
      hasActiveCall = true;
    }
  }

  return hasActiveCall;
};

voiceCallSchema.statics.getUserActiveCall = async function(userId) {
  const STALE_THRESHOLD = 2 * 60 * 1000;
  const staleTime = new Date(Date.now() - STALE_THRESHOLD);

  await this.updateMany(
    {
      $or: [{ callerId: userId }, { receiverId: userId }],
      status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] },
      initiatedAt: { $lt: staleTime }
    },
    { $set: { status: 'ENDED', endedAt: new Date(), endReason: 'auto_timeout' } }
  );

  return this.findOne({
    $or: [{ callerId: userId }, { receiverId: userId }],
    status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }
  });
};

voiceCallSchema.statics.countRecentAttempts = async function(callerId, bookingId, hours = 1) {
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  return this.countDocuments({
    callerId,
    bookingId,
    createdAt: { $gte: cutoffTime }
  });
};

voiceCallSchema.statics.getBookingCallStats = async function(bookingId) {
  const calls = await this.find({ bookingId });
  return {
    total:         calls.length,
    connected:     calls.filter(c => c.status === 'CONNECTED' || c.status === 'ENDED').length,
    declined:      calls.filter(c => c.status === 'DECLINED').length,
    timeout:       calls.filter(c => c.status === 'TIMEOUT').length,
    failed:        calls.filter(c => c.status === 'FAILED').length,
    totalDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0)
  };
};

voiceCallSchema.statics.cleanupStaleCalls = async function() {
  const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
  const result = await this.updateMany(
    { status: 'RINGING', initiatedAt: { $lt: thirtySecondsAgo } },
    { $set: { status: 'TIMEOUT', endedAt: new Date(), endReason: 'no_answer' } }
  );
  return result.modifiedCount;
};

voiceCallSchema.statics.expireConnectedCalls = async function() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const result = await this.updateMany(
    { status: 'CONNECTED', connectedAt: { $lt: twoHoursAgo } },
    { $set: { status: 'ENDED', endedAt: new Date(), endReason: 'max_duration_exceeded' } }
  );
  return result.modifiedCount;
};

voiceCallSchema.statics.cleanupAllStaleCalls = async function(thresholdMinutes = 2) {
  const staleTime = new Date(Date.now() - thresholdMinutes * 60 * 1000);
  console.log('🧹 Running global stale call cleanup...');
  const result = await this.updateMany(
    { status: { $in: ['RINGING', 'CONNECTING', 'CONNECTED'] }, initiatedAt: { $lt: staleTime } },
    { $set: { status: 'ENDED', endedAt: new Date(), endReason: 'stale_cleanup' } }
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
module.exports = mongoose.model('VoiceCall', voiceCallSchema);
