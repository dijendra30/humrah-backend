// models/SportsSessionMember.js
// -----------------------------------------------------------------------------
// Sports & Fitness — Phase 2A. One person's place in a Sports session.
//
// Modelled on Humrah Rooms' RoomMember (role, status, joinedAt / leftAt, a
// server-kept lastReadAt), not on Surprise Activity's two-person chat: a session
// has any number of members.
//
// Follows the plan: a member is JOINED exactly while they are in
// SportsPlan.playersJoined. Leaving marks them LEFT (the row is kept, so the
// session's history and a later rejoin are both simple); REMOVED is for someone
// the host removes, which Phase 1A has no route for yet.
//
// Only ids and session state — no copied profile data. Names and photos come
// from User when the session is read, as for plans.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const sportsSessionMemberSchema = new mongoose.Schema({
  sessionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'SportsSession', required: true },
  sportsPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'SportsPlan', required: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role:         { type: String, enum: ['HOST', 'PARTICIPANT'], default: 'PARTICIPANT' },
  status:       { type: String, enum: ['JOINED', 'LEFT', 'REMOVED'], default: 'JOINED' },
  joinedAt:     { type: Date, default: Date.now },
  leftAt:       { type: Date, default: null },
  // Phase 3: set when the member reads the session's chat (server-authoritative,
  // like RoomMember.lastReadAt). Null = never read. Only ever moves forward.
  lastReadAt:   { type: Date, default: null },
  // Phase 3: how many times this person has become JOINED. Part of the key that
  // makes "X joined the session" appear once per join — a retried join adds
  // nothing, a genuine re-join after leaving adds a new one.
  joinCount:    { type: Number, default: 0 },
  // Phase 4: new-message push state (services/sportsChatService.js,
  // notifyNewMessage / flushMessagePushes). Optional — a row without it has never
  // had a message push. No defaults, so nothing is written until the first push.
  //   lastSentAt            when the last message push to this member went out
  //                         (the start of their 3-minute window)
  //   pendingCount          messages that arrived during the window, not yet pushed
  //   pendingSince          when the first of those arrived
  //   pendingLastMessageId  the newest of them
  push: {
    lastSentAt:           { type: Date },
    pendingCount:         { type: Number },
    pendingSince:         { type: Date },
    pendingLastMessageId: { type: mongoose.Schema.Types.ObjectId },
  },
}, { timestamps: true });

// One row per person per session; upserts on this pair keep joins idempotent.
sportsSessionMemberSchema.index({ sessionId: 1, userId: 1 }, { unique: true });
// "My sessions" and membership checks by user.
sportsSessionMemberSchema.index({ userId: 1, status: 1 });
// Phase 4: the every-minute flush finds rows with pushes waiting. Partial, so it
// only ever holds the few rows that have something pending.
sportsSessionMemberSchema.index(
  { 'push.pendingCount': 1, 'push.lastSentAt': 1 },
  { partialFilterExpression: { 'push.pendingCount': { $gt: 0 } } },
);

module.exports = mongoose.model('SportsSessionMember', sportsSessionMemberSchema);
