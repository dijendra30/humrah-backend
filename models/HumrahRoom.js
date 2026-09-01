const mongoose = require('mongoose');

const humrahRoomSchema = new mongoose.Schema({
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  discoveryMode: { type: String, enum: ['NEAR_ME', 'ALL_INDIA', 'PRIVATE'], required: true },
  topic: { type: String, default: '' },
  capacity: { type: Number, required: true, min: 2, max: 10 },
  status: { type: String, enum: ['SUGGESTED', 'ACTIVE', 'FULL', 'INACTIVE', 'CLOSED'], default: 'ACTIVE' },
  expiresAt: { type: Date },
  lastMessageAt: { type: Date, default: Date.now }
}, { timestamps: true });

humrahRoomSchema.index({ discoveryMode: 1, status: 1 });
module.exports = mongoose.model('HumrahRoom', humrahRoomSchema);
