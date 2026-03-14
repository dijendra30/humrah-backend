const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
//  CHAT MESSAGE SUB-SCHEMA
// ─────────────────────────────────────────────────────────────

const ReactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  emoji:  { type: String, required: true }
}, { _id: false });

const ChatMessageSchema = new mongoose.Schema({
  senderId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderUsername: { type: String, required: true },
  text:           { type: String, required: true, maxlength: 500 },
  sentAt:         { type: Date, default: Date.now },
  isPinned:       { type: Boolean, default: false },
  isSystemMsg:    { type: Boolean, default: false },
  reactions:      [ReactionSchema]
});

// ─────────────────────────────────────────────────────────────
//  GAMING SESSION SCHEMA  (§5 of prompt)
//
//  Fields per prompt:
//    hostId, game, playersNeeded, playersJoined,
//    status, boostLevel, notInterestedUsers, createdAt, expiresAt
//
//  Additional fields needed for full functionality:
//    hostUsername, city, customGameName, startTime,
//    chatExpiresAt, kickedPlayers, mutedPlayers,
//    pinnedMessageId, messages, lastMessageAt
// ─────────────────────────────────────────────────────────────

const GamingSessionSchema = new mongoose.Schema({

  // ── Core fields from prompt ───────────────────────────────
  hostId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true
  },
  hostUsername: {
    type:     String,
    required: true
  },
  city: {
    type:     String,
    required: true,
    index:    true
  },
  game: {
    type:     String,
    required: true,
    enum:     ['BGMI','PUBG','PUBG_PC','CALL_OF_DUTY','FREE_FIRE',
               'PHASMOPHOBIA','MINECRAFT','DEAD_BY_DAYLIGHT','AMONG_US','OTHER']
  },
  customGameName: {
    type:    String,
    default: null
  },
  playersNeeded: {
    type:     Number,
    required: true,
    min:      2,
    max:      6
  },
  playersJoined: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User'
  }],

  // ── Status (§4) ───────────────────────────────────────────
  status: {
    type:    String,
    enum:    ['waiting_for_players','full','starting','in_progress','completed','expired','cancelled'],
    default: 'waiting_for_players',
    index:   true
  },

  // ── Boost level (§2, §11) ─────────────────────────────────
  boostLevel: {
    type:    String,
    enum:    ['NORMAL','BOOST20','BOOST50'],
    default: 'NORMAL'
  },

  // ── Not interested tracking (§12) ─────────────────────────
  notInterestedUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User'
  }],

  // ── Timing ────────────────────────────────────────────────
  startTime: {
    type:     Date,
    required: true
  },
  chatExpiresAt: {
    type: Date   // set to startTime + 3h on create
  },
  expiresAt: {
    type:  Date,  // §4: createdAt + 10min if not filled
    index: true
  },

  // ── Host controls ─────────────────────────────────────────
  kickedPlayers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User'
  }],
  mutedPlayers: [{
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    mutedUntil: { type: Date }
  }],

  // ── Chat ──────────────────────────────────────────────────
  pinnedMessageId: {
    type:    mongoose.Schema.Types.ObjectId,
    default: null
  },
  messages: [ChatMessageSchema],

  optionalMessage: {
    type:    String,
    default: null,
    maxlength: 200
  }

}, {
  timestamps: true   // createdAt, updatedAt
});

// ── TTL index: MongoDB auto-deletes expired session docs ──────
GamingSessionSchema.index({ chatExpiresAt: 1 }, { expireAfterSeconds: 10800 }); // +3h

// ── Helpers ───────────────────────────────────────────────────

GamingSessionSchema.methods.isFull = function () {
  // +1 for host
  return (this.playersJoined.length + 1) >= this.playersNeeded;
};

GamingSessionSchema.methods.currentPlayerCount = function () {
  return this.playersJoined.length + 1;
};

GamingSessionSchema.methods.isExpired = function () {
  return this.expiresAt && new Date() > this.expiresAt;
};

// ── Serialiser: expose sessionId + camelCase frontend names ──
GamingSessionSchema.methods.toClientJSON = function () {
  const obj = this.toObject({ virtuals: true });
  return {
    sessionId:          obj._id,
    creatorId:          obj.hostId,
    creatorUsername:    obj.hostUsername,
    creatorCity:        obj.city,
    gameType:           obj.game,
    customGameName:     obj.customGameName,
    playersNeeded:      obj.playersNeeded,
    playersJoined:      obj.playersJoined,
    kickedPlayers:      obj.kickedPlayers,
    mutedPlayers:       obj.mutedPlayers,
    notInterestedUsers: obj.notInterestedUsers,
    boostLevel:         obj.boostLevel,
    startTime:          obj.startTime,
    chatExpiresAt:      obj.chatExpiresAt,
    createdAt:          obj.createdAt,
    status:             obj.status,
    optionalMessage:    obj.optionalMessage,
    pinnedMessageId:    obj.pinnedMessageId
  };
};

module.exports = mongoose.model('GamingSession', GamingSessionSchema);
