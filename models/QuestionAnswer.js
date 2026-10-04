// models/QuestionAnswer.js
// -----------------------------------------------------------------------------
// An answer to a Question. One ACTIVE answer per person per question (a deleted one
// does not count). Soft delete only. It is not a chat: nothing here opens one.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:       { type: String, required: true, maxlength: 4000 },   // 300 graphemes
  status:     { type: String, enum: ['ACTIVE', 'DELETED', 'HIDDEN'], default: 'ACTIVE', required: true },
  replyCount: { type: Number, default: 0, min: 0 },
  deletedAt:  { type: Date, default: null },
}, { timestamps: true });

// One active answer per person per question.
answerSchema.index({ questionId: 1, authorId: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } });
// The answers of a question, oldest first.
answerSchema.index({ questionId: 1, createdAt: 1 });

module.exports = mongoose.model('QuestionAnswer', answerSchema);
