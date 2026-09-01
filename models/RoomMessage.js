const mongoose = require('mongoose');

const roomMessageSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'HumrahRoom', required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  messageType: { type: String, enum: ['TEXT', 'SYSTEM_NOTIFICATION'], default: 'TEXT' },
  content: { type: String, required: true }
}, { timestamps: true });

roomMessageSchema.index({ roomId: 1, createdAt: -1 });
module.exports = mongoose.model('RoomMessage', roomMessageSchema);
