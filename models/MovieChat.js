// models/MovieChat.js
const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  // senderId is null for system messages
  senderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  senderName:  { type: String, required: true },
  senderPhoto: { type: String, default: null },
  text:        { type: String, required: true },
  isSystem:    { type: Boolean, default: false }, // true = auto-generated chat message
  timestamp:   { type: Date, default: Date.now },
});

const movieChatSchema = new mongoose.Schema({
  // sessionId set after session is created (avoids circular dependency)
  sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'MovieSession', default: null },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  messages:     [chatMessageSchema],
  expiresAt:    { type: Date, required: true },
  status:       { type: String, enum: ['active', 'expired'], default: 'active' },
}, { timestamps: true });

movieChatSchema.index({ sessionId: 1 });
movieChatSchema.index({ expiresAt: 1 });

// ── Helper: push a system message into a chat ──────────────────────────────────
// Used by joinSession and createSession to add automatic chat messages.
movieChatSchema.methods.addSystemMessage = async function (text) {
  this.messages.push({
    senderId:    null,
    senderName:  'Humrah',
    senderPhoto: null,
    text,
    isSystem:    true,
    timestamp:   new Date(),
  });
  return this.save();
};

module.exports = mongoose.model('MovieChat', movieChatSchema);
