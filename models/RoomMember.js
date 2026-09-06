const mongoose = require('mongoose');

const roomMemberSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'HumrahRoom', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['HOST', 'PARTICIPANT'], default: 'PARTICIPANT' },
  status: { type: String, enum: ['INVITED', 'JOINED', 'LEFT', 'KICKED'], default: 'JOINED' },
  joinedAt: { type: Date, default: Date.now },
  leftAt: { type: Date },
  // Phase 2.1: server-authoritative read state. Set only when the user actually
  // opens / catches up in the Room (POST /api/rooms/:roomId/read) — never by a
  // push notification being delivered. null = never read.
  lastReadAt: { type: Date, default: null }
}, { timestamps: true });

roomMemberSchema.index({ roomId: 1, userId: 1 }, { unique: true });
// R0: hot path — getMyRooms, discoverRooms exclusion, invitation worker all
// query RoomMember by { userId, status }.
roomMemberSchema.index({ userId: 1, status: 1 });
module.exports = mongoose.model('RoomMember', roomMemberSchema);
