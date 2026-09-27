// models/SportsHiddenMessage.js
// -----------------------------------------------------------------------------
// Sports chat enhancement — "Delete for me". One row = one person has hidden one
// message from their own view of a Sports session's chat.
//
// Its own collection, not an array on the message: a message could otherwise
// grow a list of every member who ever hid it, and every read of that message
// would carry the list. Here a hide is one small row, found by a unique index.
//
// Nothing else changes: the message, its text, its reactions, the session's
// preview, lastMessageAt and everyone else's view stay exactly as they were.
// Nobody is told. Ids only — no text, no profile data.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const sportsHiddenMessageSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsSession', required: true },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsMessage', required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One hide per person per message (a repeated "delete for me" is a no-op), and
// "which of these messages has this person hidden?" for a page of history.
sportsHiddenMessageSchema.index({ userId: 1, messageId: 1 }, { unique: true });

module.exports = mongoose.model('SportsHiddenMessage', sportsHiddenMessageSchema);
