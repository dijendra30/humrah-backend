const mongoose = require('mongoose');

const roomMessageSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'HumrahRoom', required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  messageType: { type: String, enum: ['TEXT', 'SYSTEM_NOTIFICATION'], default: 'TEXT' },
  content: { type: String, required: true },
  // Client-generated idempotency key. Used to reconcile the sender's optimistic
  // bubble with the persisted message and to drop duplicate sends after a socket
  // reconnect. Optional (system messages have none).
  clientMessageId: { type: String, default: null }
}, { timestamps: true });

roomMessageSchema.index({ roomId: 1, createdAt: -1 });
// Dedupe a given sender's retries within a room. partialFilterExpression (not
// `sparse`) so the unique constraint applies ONLY when clientMessageId is a real
// string — messages without one (system notifications, legacy clients) are exempt
// and can coexist freely.
roomMessageSchema.index(
  { roomId: 1, senderId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } }
);

module.exports = mongoose.model('RoomMessage', roomMessageSchema);
