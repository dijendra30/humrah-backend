// models/MoodChat.js
// Private 1-on-1 chat room created when a mood request is accepted.
'use strict';
const mongoose = require('mongoose');

const moodChatSchema = new mongoose.Schema({
  users:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  mood:      { type: String, required: true },
  vibeLevel: { type: String, default: 'normal' },
  active:    { type: Boolean, default: true, index: true },

  // Linked request
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'MoodRequest', default: null },

  messages: [{
    senderId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text:      { type: String, required: true, maxlength: 500 },
    createdAt: { type: Date, default: Date.now },
  }],

  // Auto-expire chat 24h after creation
  expiresAt:  { type: Date, required: true, index: true },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
}, {
  collection: 'moodchats',
  timestamps: false,
});

moodChatSchema.index({ users: 1 });
moodChatSchema.index({ users: 1, active: 1 });

module.exports = mongoose.model('MoodChat', moodChatSchema);
