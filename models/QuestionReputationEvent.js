// models/QuestionReputationEvent.js
// -----------------------------------------------------------------------------
// Ask a Question — Phase 6 Replier Level: the reputation LEDGER. One row per award, written
// once and never changed or removed (updates and deletes are refused below). Every point a
// user has comes from a row here; QuestionReputation is only a fast summary of these rows.
//
//   ANSWER_CREATED  +10 for a valid answer — once per (user, question), so deleting and
//                   re-answering earns nothing more. A row with 0 points and capped=true
//                   records an answer made after the day's +100 answer cap.
//   ANSWER_HELPFUL  +15 when the question's asker marks the answer Helpful — once per answer.
//
// dedupeKey (unique) makes every award idempotent under retries and concurrency.
// No text is stored: ids, the type, points and the day only.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const EVENT_TYPES = ['ANSWER_CREATED', 'ANSWER_HELPFUL'];

const eventSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },    // who earned it
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  answerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionAnswer', required: true },
  eventType:  { type: String, enum: EVENT_TYPES, required: true },
  points:     { type: Number, required: true, min: 0 },
  capped:     { type: Boolean, default: false },              // ANSWER_CREATED after the daily cap (points 0)
  markedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },    // ANSWER_HELPFUL: the asker
  day:        { type: String, required: true },               // YYYY-MM-DD in India time (the daily cap's day)
  dedupeKey:  { type: String, required: true },
  createdAt:  { type: Date, default: Date.now },
}, { versionKey: false });

eventSchema.index({ dedupeKey: 1 }, { unique: true });
// A user's history, newest first (the dashboard), and their total.
eventSchema.index({ userId: 1, createdAt: -1, _id: -1 });
eventSchema.index({ answerId: 1 });

// Immutable: the ledger is append-only.
const refuse = function (next) { next(new Error('QuestionReputationEvent is append-only')); };
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  eventSchema.pre(op, refuse);
}
eventSchema.pre('save', function (next) { if (!this.isNew) return next(new Error('QuestionReputationEvent is append-only')); return next(); });

module.exports = mongoose.model('QuestionReputationEvent', eventSchema);
module.exports.EVENT_TYPES = EVENT_TYPES;
