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

  // "Leave Conversation": who left and when. A person who left no longer sees the
  // chat in their lists and nobody can send until it is reopened by an accepted
  // request (acceptRequest clears this). History is kept for both people.
  leftBy: [{
    _id:    false,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at:     { type: Date, default: Date.now },
  }],

  // One-to-one chats no longer expire. Kept (not required, no TTL) only because
  // older documents carry a value; nothing reads it to close or hide a chat.
  expiresAt:  { type: Date, default: null, index: true },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
}, {
  collection: 'moodchats',
  timestamps: false,
});

moodChatSchema.index({ users: 1 });
moodChatSchema.index({ users: 1, active: 1 });

module.exports = mongoose.model('MoodChat', moodChatSchema);
