// models/SportsMessage.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 3. One message in a Sports session's group chat.
//
//   SportsPlan ──1:1── SportsSession ──1:N── SportsMessage
//
// Its own collection rather than Humrah Rooms' RoomMessage: RoomMessage.roomId
// points at HumrahRoom, and Rooms' engagement, discovery and AI-host logic read
// that collection, so Sports rows there would be counted as Room conversation.
// The DESIGN is Rooms' — a client idempotency key, reactions kept on the message
// (one emoji per person), system rows the server writes.
//
//   TEXT    a member's message. senderId is the authenticated caller, never a
//           value from the request body.
//   SYSTEM  written only by the server when membership or status changes
//           (MEMBER_JOINED / MEMBER_LEFT / SESSION_CANCELLED). subjectUserId is
//           who it is about; the wording ("Arjun joined the session") is made
//           when the message is read, so no name is ever stored here.
//
// No profile data, no Google Places data. Never deleted: an expired or cancelled
// chat keeps its history.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const SYSTEM_EVENTS = ['MEMBER_JOINED', 'MEMBER_LEFT', 'SESSION_CANCELLED'];

const sportsMessageSchema = new mongoose.Schema({
  sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'SportsSession', required: true },
  sportsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsPlan', required: true },
  messageType:  { type: String, enum: ['TEXT', 'SYSTEM'], required: true },

  // TEXT
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    required: function () { return this.messageType === 'TEXT'; },
  },
  text: {
    type: String,
    default: null,
    maxlength: 1000,
    required: function () { return this.messageType === 'TEXT'; },
  },
  // Retries of the same send carry the same key and land on the same row.
  clientMessageId: { type: String, default: null },

  // SYSTEM
  systemEvent:   { type: String, enum: [...SYSTEM_EVENTS, null], default: null },
  subjectUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // e.g. "MEMBER_JOINED:<userId>:<joinCount>" — one row per real membership change.
  systemKey:     { type: String, default: null },

  // Rooms' shape: one entry per emoji, userIds = who chose it. A person holds at
  // most one emoji per message (enforced atomically in the update).
  reactions: {
    type: [{
      _id: false,
      emoji:   { type: String, required: true },
      userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    }],
    default: [],
  },
}, { timestamps: true });

// History, newest first, with a (createdAt, _id) cursor; also unread counting
// ("newer than lastReadAt") and the newest message of a session.
sportsMessageSchema.index({ sessionId: 1, createdAt: -1, _id: -1 });

// A retried send is the same message. Partial (not sparse) so the rule applies
// only to real keys — system messages have none.
sportsMessageSchema.index(
  { sessionId: 1, senderId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);

// A membership change is announced once, however many times its hook runs.
sportsMessageSchema.index(
  { sessionId: 1, systemKey: 1 },
  { unique: true, partialFilterExpression: { systemKey: { $type: 'string' } } },
);

module.exports = mongoose.model('SportsMessage', sportsMessageSchema);
module.exports.SYSTEM_EVENTS = SYSTEM_EVENTS;
