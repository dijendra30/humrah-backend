// models/RoomHiddenMessage.js
// Phase 3.1: "delete for me" in a Humrah Room. Only the member who hid a message stops
// seeing it; nobody else is affected. One row per (member, message).
'use strict';
const mongoose = require('mongoose');

const roomHiddenMessageSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  roomId:    { type: mongoose.Schema.Types.ObjectId, ref: 'HumrahRoom', required: true },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'RoomMessage', required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

roomHiddenMessageSchema.index({ userId: 1, messageId: 1 }, { unique: true });

module.exports = mongoose.model('RoomHiddenMessage', roomHiddenMessageSchema);
