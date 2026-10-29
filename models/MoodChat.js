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
    // Emptied when the author deletes it for everyone (deletedForEveryoneAt set).
    text:      { type: String, required: function () { return !this.deletedForEveryoneAt; }, maxlength: 500 },
    createdAt: { type: Date, default: Date.now },

    // Person-to-person chat actions (services/personChatService.js). All optional:
    // messages written before these existed read exactly as they did.
    replyTo: {
      messageId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
      senderId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
      text:      { type: String, maxlength: 160, default: undefined },
    },
    reactions: [{
      _id:    false,
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      emoji:  { type: String, required: true },
    }],
    editedAt:             { type: Date, default: null },
    deletedForEveryoneAt: { type: Date, default: null },
    // "Delete for me": hidden only for these people.
    hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  }],

  // People who turned off notifications for this chat (never shown to the other person).
  mutedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

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
