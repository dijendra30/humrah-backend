// models/MovieHiddenMessage.js
// -----------------------------------------------------------------------------
// Movie Hangout — "Delete for me". One row = one person has hidden one message
// from their own view of a hangout's chat. The Sports pattern
// (models/SportsHiddenMessage.js): its own collection, found by a unique index.
//
// Nothing else changes: the message, its reactions and everyone else's view stay
// exactly as they were. Nobody is told. Ids only.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const movieHiddenMessageSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'MovieSession', required: true },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'MovieMessage', required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One hide per person per message (a repeated "delete for me" is a no-op).
movieHiddenMessageSchema.index({ userId: 1, messageId: 1 }, { unique: true });
movieHiddenMessageSchema.index({ userId: 1, sessionId: 1 });

module.exports = mongoose.model('MovieHiddenMessage', movieHiddenMessageSchema);
