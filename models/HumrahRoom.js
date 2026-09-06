const mongoose = require('mongoose');

const humrahRoomSchema = new mongoose.Schema({
  creationSource: { type: String, enum: ['USER', 'SYSTEM'], default: 'USER' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: function() { return this.creationSource === 'USER'; } },
  discoveryMode: { type: String, enum: ['NEAR_ME', 'ALL_INDIA', 'PRIVATE'], required: true },
  title: { type: String, required: true, trim: true, maxlength: 30 },
  description: { type: String, trim: true },
  topic: { type: String, required: true },
  languages: { type: [String], default: [] },
  capacity: { type: Number, required: true, min: 2, max: 5 },
  status: { type: String, enum: ['SUGGESTED', 'ACTIVE', 'FULL', 'INACTIVE', 'CLOSED'], default: 'ACTIVE' },
  expiresAt: { type: Date },
  // Denormalized count of JOINED RoomMember records. Maintained under the Redis
  // room lock in joinRoom / leaveRoom / createRoom. INVITED members are excluded.
  memberCount: { type: Number, default: 0, min: 0 },
  // R1: no default — a Room only has a lastMessageAt once a real message is
  // persisted (set from the message's createdAt in humrahRoomSocket.js).
  // The expiry job already handles lastMessageAt === null explicitly.
  lastMessageAt: { type: Date, default: null }
}, { timestamps: true });

humrahRoomSchema.index({ discoveryMode: 1, status: 1 });
// R0: invitation worker + expiry job scan by creationSource + status + createdAt.
humrahRoomSchema.index({ creationSource: 1, status: 1, createdAt: 1 });
// R0: expiry job sweeps ACTIVE/FULL rooms by lastMessageAt.
humrahRoomSchema.index({ status: 1, lastMessageAt: 1 });
module.exports = mongoose.model('HumrahRoom', humrahRoomSchema);
