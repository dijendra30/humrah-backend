const mongoose = require('mongoose');

const roomMemberSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'HumrahRoom', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['HOST', 'PARTICIPANT'], default: 'PARTICIPANT' },
  status: { type: String, enum: ['INVITED', 'JOINED', 'LEFT', 'KICKED'], default: 'JOINED' },
  joinedAt: { type: Date, default: Date.now },
  leftAt: { type: Date }
}, { timestamps: true });

roomMemberSchema.index({ roomId: 1, userId: 1 }, { unique: true });
module.exports = mongoose.model('RoomMember', roomMemberSchema);
