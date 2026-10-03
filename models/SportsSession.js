// models/SportsSession.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 2A. The session a Sports plan becomes: the group of
// people playing, which Messages → Sessions lists and Phase 3's group chat will
// hang off.
//
// Exactly one per plan (unique sportsPlanId). The plan stays the source of truth
// for WHO is in it (SportsPlan.playersJoined) and WHEN (startTime / endTime);
// this document carries only what belongs to the session itself. Its members are
// SportsSessionMember documents, kept in step with the plan — see
// services/sportsSessionService.js.
//
//   status  'active' until the plan is cancelled, then 'cancelled'. Upcoming /
//           live / ended are worked out from the plan's times when read, the way
//           Phase 1A derives an expired card, so nothing has to flip them on time.
//
// No TTL and never deleted: a session is the plan's history, and Phase 3 will
// keep its messages.
//
// Phase 3 — group chat (services/sportsChatService.js):
//   status 'expired'  the chat has had no qualifying activity for 7 days (counted
//                     from its last activity, and never before the game has ended).
//                     Derived on every read and send; this field records it once
//                     seen, with expiredAt = the moment it expired, not when noticed.
//   lastMessageAt     the last QUALIFYING activity: a member's message or a join.
//                     Only ever moved forward ($max). Reading, typing, reactions,
//                     leaves and cancellation never touch it.
//   lastMessage       a small preview of the newest message of any kind, for
//                     Messages → Sessions without reading the messages collection.
//                     No names or photos: ids only, resolved when read.
//                     Chat enhancement: messageId (so an edit or a delete of the
//                     newest message can update it) and deletionType (the preview
//                     of a deleted message says so, and never keeps its text).
//
// No-join outcome (services/sportsSessionService.js, tickNoJoin):
//   noJoinAt          set once, by the every-minute Sports tick, when the plan has
//                     started (joins are closed) and nobody but the host ever joined.
//                     The same guarded update sets status 'expired' (expiredAt =
//                     noJoinAt), so every existing write guard refuses the chat from
//                     then on. The chat leaves Messages → Sessions an hour later.
//                     Null for every other session, so nothing else changes.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const lastMessageSchema = new mongoose.Schema({
  messageId:     { type: mongoose.Schema.Types.ObjectId, ref: 'SportsMessage', default: null },
  messageType:   { type: String, enum: ['TEXT', 'SYSTEM'], required: true },
  text:          { type: String, default: null },        // TEXT only, ≤ 140 chars
  senderId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  systemEvent:   { type: String, default: null },
  subjectUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deletionType:  { type: String, default: null },        // 'USER' | 'HOST' once deleted
  createdAt:     { type: Date, required: true },
}, { _id: false });

const sportsSessionSchema = new mongoose.Schema({
  sportsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsPlan', required: true },
  creatorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:       { type: String, enum: ['active', 'cancelled', 'expired'], default: 'active' },
  cancelledAt:  { type: Date, default: null },
  expiredAt:    { type: Date, default: null },
  lastMessageAt: { type: Date, default: null },
  lastMessage:   { type: lastMessageSchema, default: null },
  noJoinAt:      { type: Date, default: null },
}, { timestamps: true });

// One session per plan. Also what makes creation idempotent: a retried or racing
// create upserts onto the same document instead of adding a second.
sportsSessionSchema.index({ sportsPlanId: 1 }, { unique: true });

module.exports = mongoose.model('SportsSession', sportsSessionSchema);
