const mongoose = require('mongoose');

const roomMessageSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'HumrahRoom', required: true },
  // R6.2: NOT required for AI_HOST messages. The AI Host is not a user, has no
  // account, and must never borrow a human's senderId — so this stays null for it.
  // Same conditional-required idiom already used by HumrahRoom.createdBy.
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function () { return this.messageType !== 'AI_HOST'; },
    default: null,
  },
  // AI_HOST (R6.2) makes an AI message distinguishable at the DATA layer, not just
  // in the UI. It is deliberately NOT 'TEXT': every existing participant/activity
  // query filters on messageType 'TEXT', so an AI message can never be counted as
  // human conversation by R5 engagement, discovery or the last-sender lookup.
  messageType: { type: String, enum: ['TEXT', 'SYSTEM_NOTIFICATION', 'AI_HOST'], default: 'TEXT' },
  content: { type: String, required: true },
  // Client-generated idempotency key. Used to reconcile the sender's optimistic
  // bubble with the persisted message and to drop duplicate sends after a socket
  // reconnect. Optional (system messages have none).
  clientMessageId: { type: String, default: null },
  // Phase 2.1: emoji reactions. One entry per emoji; userIds is the set of members
  // who chose it. A user may hold at most one instance of a given emoji (enforced
  // atomically with $addToSet), and at most one emoji overall per message (the
  // controller pulls the user out of every other emoji in the same update).
  reactions: {
    type: [{
      _id: false,
      emoji: { type: String, required: true },
      userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    }],
    default: [],
  }
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
