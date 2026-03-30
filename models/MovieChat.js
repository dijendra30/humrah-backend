// models/MovieChat.js
const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  senderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName:  { type: String, required: true },
  senderPhoto: { type: String, default: null },
  text:        { type: String, required: true },
  timestamp:   { type: Date, default: Date.now }
});

const movieChatSchema = new mongoose.Schema({
  // ✅ NOT required — sessionId is set after the session is created to avoid
  //    a circular dependency (session needs chatId, chat needs sessionId).
  sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'MovieSession', default: null },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  messages:     [chatMessageSchema],
  expiresAt:    { type: Date, required: true },
  status:       { type: String, enum: ['active', 'expired'], default: 'active' }
}, { timestamps: true });

movieChatSchema.index({ sessionId: 1 });
movieChatSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('MovieChat', movieChatSchema);
