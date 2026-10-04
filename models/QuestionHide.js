// models/QuestionHide.js
// -----------------------------------------------------------------------------
// A question one user does not want in their discovery any more ("Hide", or after
// reporting it). Per user only: nothing changes for anyone else.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const hideSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  reason:     { type: String, enum: ['HIDDEN', 'REPORTED'], default: 'HIDDEN' },
}, { timestamps: true });

hideSchema.index({ userId: 1, questionId: 1 }, { unique: true });
hideSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('QuestionHide', hideSchema);
