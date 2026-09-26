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
  // like RoomMember.lastReadAt). Null = never read.
  lastReadAt:   { type: Date, default: null },
}, { timestamps: true });

// One row per person per session; upserts on this pair keep joins idempotent.
sportsSessionMemberSchema.index({ sessionId: 1, userId: 1 }, { unique: true });
// "My sessions" and membership checks by user.
sportsSessionMemberSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('SportsSessionMember', sportsSessionMemberSchema);
