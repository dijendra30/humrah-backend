// models/Meetup.js
// -----------------------------------------------------------------------------
// R7.1 — the Meetup foundation.
//
// REPLACES a 14-line legacy stub (status PROPOSED/CONFIRMED/CANCELLED, a `votes`
// array, raw lat/lng at the top level). That stub was DEAD CODE: nothing in the
// codebase ever required it, so mongoose.model('Meetup') was never registered and
// no document was ever written. It is replaced rather than sat alongside, because
// two files registering the same model name throw OverwriteModelError.
//
// DESIGN RULES (spec §2, §3, §15, §19):
//   - Meetup state lives HERE. Never on HumrahRoom, never on RoomMember. Rooms and
//     memberships are untouched by R7.
//   - Minimal data. No emails, phones, tokens, passwords, profile bodies, and no
//     member coordinates — ever. The only coordinates this model can hold belong
//     to a PUBLIC VENUE inside selectedPlace, which is not personal data.
//   - Server-authoritative. Every field here is written by the backend from
//     backend-derived values. Nothing a client sends is trusted into this schema.
//   - Later R7 phases extend it; R7.1 leaves the future fields present but empty
//     rather than faking behaviour for them.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const { MEETUP_STATUS, ACTIVE_STATUSES, TERMINAL_STATUSES } = require('../services/meetup/meetupStateMachine');

/**
 * A place a Meetup could happen at (spec §15). Shaped now so R7.2 can populate it
 * from Google Places without a migration; R7.1 never writes it and never calls any
 * places API.
 *
 * latitude/longitude here are the VENUE's published coordinates — a cafe's address
 * on a map. They are NOT, and must never be, a member's location.
 */
const meetupPlaceSchema = new mongoose.Schema({
  // 'GOOGLE_PLACES' is reserved for R7.2. 'MANUAL' covers a user-typed venue.
  provider: { type: String, enum: ['GOOGLE_PLACES', 'MANUAL'], default: null },
  providerPlaceId: { type: String, default: null },
  name: { type: String, default: null, trim: true },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  photoReference: { type: String, default: null },
  rating: { type: Number, default: null },
  address: { type: String, default: null, trim: true },
  openingStatus: { type: String, default: null },
}, { _id: false });

/** A candidate or chosen time window (spec §16). R7.1 never writes these. */
const meetupTimeSchema = new mongoose.Schema({
  startAt: { type: Date, default: null },
  endAt: { type: Date, default: null },
}, { _id: false });

/**
 * Who was in the Room when the proposal was made (spec §3).
 *
 * Deliberately three fields. Enough to know the Meetup was proposed into a real
 * membership and to detect later drift; not enough to reconstruct anyone's
 * profile. Live RoomMember state remains authoritative for permission checks —
 * this is a historical record, never a substitute for validation.
 */
const participantSnapshotSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  membershipStatus: { type: String, enum: ['JOINED'], required: true },
  joinedAt: { type: Date, default: null },
}, { _id: false });

const meetupSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'HumrahRoom', required: true },
  proposedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  status: {
    type: String,
    enum: Object.values(MEETUP_STATUS),
    default: MEETUP_STATUS.PROPOSED,
    required: true,
  },

  /**
   * THE ONE-ACTIVE-MEETUP-PER-ROOM ENFORCEMENT (spec §8).
   *
   * Equals roomId while the Meetup is in an ACTIVE status; set to null the instant
   * it reaches a TERMINAL one. A unique partial index below indexes only the
   * ObjectId values, so the database itself refuses a second active Meetup for a
   * Room — a duplicate-key error, not a race-prone "check then create".
   *
   * This is deliberately a separate field rather than a partial index over
   * `{ roomId, status: { $in: [...] } }`, because $in inside partialFilterExpression
   * requires MongoDB 6.0+. The $type form works on every version Mongoose 8
   * supports, and mirrors the RoomMessage.clientMessageId idiom already in use.
   */
  activeRoomKey: { type: mongoose.Schema.Types.ObjectId, default: null },

  /**
   * Client-supplied Idempotency-Key, scoped per user by the unique index below.
   * A network retry therefore cannot create a second Meetup even if it arrives
   * while the first request is still in flight.
   */
  idempotencyKey: { type: String, default: null },

  // ── lifecycle timestamps ─────────────────────────────────────────────────
  // createdAt / updatedAt come from `timestamps: true`.
  expiresAt: { type: Date, required: true },
  votingStartedAt: { type: Date, default: null },
  confirmedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  // When the Meetup entered its terminal status. One generic field so EXPIRED and
  // REJECTED are recorded without adding a near-duplicate column for each.
  terminalAt: { type: Date, default: null },
  // Room-level cooldown gate (spec §10). Set when the Meetup reaches a status that
  // arms a cooldown. Always finite, so a Room is never permanently blocked.
  cooldownUntil: { type: Date, default: null },

  // ── future phases (R7.2+). Present, empty, and never written in R7.1. ─────
  selectedPlace: { type: meetupPlaceSchema, default: null },
  placeOptions: { type: [meetupPlaceSchema], default: [] },
  selectedTime: { type: meetupTimeSchema, default: null },
  proposedTimeOptions: { type: [meetupTimeSchema], default: [] },
  // IANA zone (e.g. "Asia/Kolkata"). Server-resolved when R7.3 needs it.
  timezone: { type: String, default: null },

  participantSnapshot: { type: [participantSnapshotSchema], default: [] },

  /**
   * Bounded operational metadata. Ids, enums, counts and reason codes only — the
   * same discipline as the telemetry allowlist. Never free text from a user, never
   * profile data, never coordinates.
   */
  metadata: {
    proposalSource: { type: String, enum: ['USER_REQUEST'], default: 'USER_REQUEST' },
    engagementStateAtProposal: { type: String, default: null },
    roomLifecycleStatusAtProposal: { type: String, default: null },
    memberCountAtProposal: { type: Number, default: 0 },
    roomAgeHoursAtProposal: { type: Number, default: null },
    terminalReason: { type: String, default: null },
  },
}, { timestamps: true });

/**
 * The single rule for what activeRoomKey must be, given a status.
 *
 * A static rather than inline hook logic so it can be asserted directly in tests:
 * this is the invariant the one-active-Meetup index depends on, and it should not
 * only be reachable through a save().
 */
meetupSchema.statics.deriveActiveRoomKey = function (status, roomId) {
  if (ACTIVE_STATUSES.has(status)) return roomId;
  if (TERMINAL_STATUSES.has(status)) return null;
  return roomId; // unknown status: keep the slot held rather than silently freeing it
};

/**
 * Keeps activeRoomKey consistent for the document-save path. The atomic
 * transition helper sets it explicitly too; this hook means a Meetup created or
 * saved by any other route still cannot end up active-but-unindexed (or terminal
 * but still holding the Room's active slot).
 */
meetupSchema.pre('save', function (next) {
  this.activeRoomKey = this.constructor.deriveActiveRoomKey(this.status, this.roomId);
  next();
});

// ── INDEXES (spec §19). Each one serves a query this phase actually makes. ────

// 1. Enforces one active Meetup per Room, in the database. Partial on $type so
//    only live rows are indexed and terminal rows never collide.
meetupSchema.index(
  { activeRoomKey: 1 },
  { unique: true, partialFilterExpression: { activeRoomKey: { $type: 'objectId' } } }
);

// 2. Enforces idempotency per user. Partial so the overwhelming majority of rows
//    (no key supplied) are exempt and can coexist freely — same construction as
//    RoomMessage's clientMessageId index.
meetupSchema.index(
  { proposedBy: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

// 3. Room Meetup history: "the latest Meetups for this Room, by status".
meetupSchema.index({ roomId: 1, status: 1, createdAt: -1 });

// 4. Cooldown lookup on the proposal hot path: is any cooldown for this Room still
//    in the future? Index 3 cannot serve it — cooldownUntil is not in that key.
meetupSchema.index({ roomId: 1, cooldownUntil: -1 });

// 5. The expiry sweep: active rows whose expiresAt has passed. Covers both the
//    hourly cron and the per-Room self-heal on the proposal path.
meetupSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('Meetup', meetupSchema);
