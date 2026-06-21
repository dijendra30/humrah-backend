// models/MoodRequest.js
// One document per request between two users.
// Requests expire with the sender's mood session (4h).
'use strict';
const mongoose = require('mongoose');

const moodRequestSchema = new mongoose.Schema({
  senderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Snapshot of sender's mood at time of request
  mood:      { type: String, required: true },
  vibeLevel: { type: String, enum: ['lowkey', 'normal', 'social'], default: 'normal' },
  message:   { type: String, default: null, maxlength: 120 },

  // Analytics: where the request originated
  requestSource: {
    type:    String,
    enum:    ['mood_match', 'people_nearby', 'community', 'featured_event'],
    default: 'mood_match',
  },

  status: {
    type:    String,
    enum:    ['pending', 'accepted', 'declined', 'expired'],
    default: 'pending',
    index:   true,
  },

  // Set when accepted
  chatRoomId: { type: mongoose.Schema.Types.ObjectId, ref: 'MoodChat', default: null },

  expiresAt:  { type: Date, required: true, index: true },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
}, {
  collection: 'moodrequests',
  timestamps: false,
});

moodRequestSchema.index({ senderId: 1, receiverId: 1, status: 1 });
moodRequestSchema.index({ receiverId: 1, status: 1, expiresAt: 1 });

module.exports = mongoose.model('MoodRequest', moodRequestSchema);
