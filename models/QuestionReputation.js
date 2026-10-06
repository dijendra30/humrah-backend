// models/QuestionReputation.js
// -----------------------------------------------------------------------------
// Ask a Question — Phase 6 Replier Level: one summary row per user, kept in step with the
// ledger (QuestionReputationEvent) by atomic $inc after each ledger insert. It exists for fast
// reads (an answer list shows each author's level) and for the two atomic claims below; every
// number can be rebuilt from the ledger (questionReputation.rebuildFromLedger).
//
//   capDay / capPoints  the +100-a-day answer cap: one conditional update claims +10 or refuses.
//   notifiedLevels      levels already announced by push — each at most once, ever.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const reputationSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  points:         { type: Number, default: 0, min: 0 },
  answerPoints:   { type: Number, default: 0, min: 0 },
  helpfulPoints:  { type: Number, default: 0, min: 0 },
  answersCounted: { type: Number, default: 0, min: 0 },      // ANSWER_CREATED rows with points
  helpfulCount:   { type: Number, default: 0, min: 0 },
  capDay:         { type: String, default: null },
  capPoints:      { type: Number, default: 0, min: 0 },
  notifiedLevels: { type: [String], default: [] },
}, { timestamps: true });

reputationSchema.index({ userId: 1 }, { unique: true });

module.exports = mongoose.model('QuestionReputation', reputationSchema);
