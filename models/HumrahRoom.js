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
  lastMessageAt: { type: Date, default: Date.now }
}, { timestamps: true });

humrahRoomSchema.index({ discoveryMode: 1, status: 1 });
// R0: invitation worker + expiry job scan by creationSource + status + createdAt.
humrahRoomSchema.index({ creationSource: 1, status: 1, createdAt: 1 });
// R0: expiry job sweeps ACTIVE/FULL rooms by lastMessageAt.
humrahRoomSchema.index({ status: 1, lastMessageAt: 1 });
module.exports = mongoose.model('HumrahRoom', humrahRoomSchema);
