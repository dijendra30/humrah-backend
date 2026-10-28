// models/MovieTicketPoll.js
// -----------------------------------------------------------------------------
// Movie Hangout — the ticket check. One per movie session, opened by the server
// an hour before the showtime ("Have you booked your movie ticket? 🎬") and closed
// at the showtime. Answers are each person's own self-reported status; nothing
// here verifies a ticket.
//
//   MovieSession ──1:0..1── MovieTicketPoll
//
// The Sports attendance check's shape (models/SportsAttendancePoll.js), for movies.
//
// sessionId is unique: it IS the idempotency key ("MOVIE_TICKET_POLL:<sessionId>"),
// so however many times the scheduler runs, on however many servers, a session
// gets one poll. Every later step is a conditional update on this document (the
// chat message, the notification claim, the close), so a step can be retried but
// never done twice.
//
// responses: one entry per person who answered (at most the session's 5 seats).
// Only ids, the answer and when. What COUNTS is decided when read: answers from
// people who are still in the hangout. Someone who leaves no longer counts, and a
// missing answer is never counted as a booked ticket.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const ANSWERS = ['BOOKED', 'NOT_YET', 'CANT_MAKE_IT'];

const responseSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answer:      { type: String, enum: ANSWERS, required: true },
  respondedAt: { type: Date, required: true },
}, { _id: false });

const movieTicketPollSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'MovieSession', required: true },
  status:    { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
  openedAt:  { type: Date, required: true },
  // The session's showTime. Kept in step with it while open (see the scheduler).
  closesAt:  { type: Date, required: true },
  closedAt:  { type: Date, default: null },
  // Who was eligible when it opened — exactly who the opening notification went to.
  eligibleAtOpen: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  responses:      { type: [responseSchema], default: [] },
  pollMessageId:  { type: mongoose.Schema.Types.ObjectId, ref: 'MovieMessage', default: null },
  // Claimed before sending: a retried tick, or a second server, finds it taken.
  notifications: {
    key:           { type: String, default: null },   // "MOVIE_TICKET_POLL:<sessionId>"
    openClaimedAt: { type: Date, default: null },
    openSent:      { type: Number, default: 0 },       // FCM accepted (not "delivered to a phone")
  },
}, { timestamps: true });

// One poll per session — the idempotency key.
movieTicketPollSchema.index({ sessionId: 1 }, { unique: true });
// The scheduler: open polls that are due to close.
movieTicketPollSchema.index({ status: 1, closesAt: 1 });

module.exports = mongoose.model('MovieTicketPoll', movieTicketPollSchema);
module.exports.ANSWERS = ANSWERS;
