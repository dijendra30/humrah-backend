const mongoose = require('mongoose');
const { maxCapacityFor } = require('../utils/curatedRoomConfig');

const humrahRoomSchema = new mongoose.Schema({
  // Phase 2.2: 'CURATED' = a durable public topic Room hosted by Humrah
  // (utils/curatedRoomConfig.js). Additive enum value — existing documents keep
  // 'USER' / 'SYSTEM' and validate exactly as before.
  creationSource: { type: String, enum: ['USER', 'SYSTEM', 'CURATED'], default: 'USER' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: function() { return this.creationSource === 'USER'; } },
  discoveryMode: { type: String, enum: ['NEAR_ME', 'ALL_INDIA', 'PRIVATE'], required: true },
  title: { type: String, required: true, trim: true, maxlength: 30 },
  description: { type: String, trim: true },
  topic: { type: String, required: true },
  languages: { type: [String], default: [] },
  // 2–5 for USER and SYSTEM Rooms (unchanged); up to 25 for CURATED Rooms only.
  // createRoom still enforces 2–5 itself and never lets a client choose CURATED.
  capacity: {
    type: Number,
    required: true,
    min: 2,
    validate: {
      validator: function (v) {
        const source = typeof this.get === 'function' ? this.get('creationSource') : this.creationSource;
        return v <= maxCapacityFor(source);
      },
      message: props => `Capacity ${props.value} is above the limit for this Room`,
    },
  },
  status: { type: String, enum: ['SUGGESTED', 'ACTIVE', 'FULL', 'INACTIVE', 'CLOSED'], default: 'ACTIVE' },
  expiresAt: { type: Date },
  // Denormalized count of JOINED RoomMember records. Maintained under the Redis
  // room lock in joinRoom / leaveRoom / createRoom. INVITED members are excluded.
  memberCount: { type: Number, default: 0, min: 0 },
  // R1: no default — a Room only has a lastMessageAt once a real message is
  // persisted (set from the message's createdAt in humrahRoomSocket.js).
  // The expiry job already handles lastMessageAt === null explicitly.
  lastMessageAt: { type: Date, default: null },
  // Phase 2.2: idempotency key of a curated Room (curatedRoomConfig.CURATED_ROOMS[].key).
  // Absent on every other Room; the partial unique index below ignores them.
  curatedTopicKey: { type: String },
  // Room supply (services/roomSupplyService.js): a Humrah-hosted Room put away because
  // there are enough user Rooms. Hidden from discovery, never deleted, its messages kept.
  // Only ever set on an empty curated Room; no default, so other Rooms never carry it.
  standby: { type: Boolean }
}, { timestamps: true });

humrahRoomSchema.index({ discoveryMode: 1, status: 1 });
// R0: invitation worker + expiry job scan by creationSource + status + createdAt.
humrahRoomSchema.index({ creationSource: 1, status: 1, createdAt: 1 });
// R0: expiry job sweeps ACTIVE/FULL rooms by lastMessageAt.
humrahRoomSchema.index({ status: 1, lastMessageAt: 1 });
// Phase 2.2: at most one curated Room per curated key (seed idempotency). Partial,
// so the Rooms without a key are not in the index at all.
humrahRoomSchema.index(
  { curatedTopicKey: 1 },
  { unique: true, partialFilterExpression: { curatedTopicKey: { $type: 'string' } } }
);
module.exports = mongoose.model('HumrahRoom', humrahRoomSchema);
