// models/QuestionReply.js
// -----------------------------------------------------------------------------
// A reply under one answer — ONE level only (a reply cannot be replied to). Only the
// question's asker and that answer's author can reply. Not a general comment system.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const replySchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  answerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionAnswer', required: true },
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:       { type: String, required: true, maxlength: 4000 },   // 300 graphemes
  status:     { type: String, enum: ['ACTIVE', 'DELETED', 'HIDDEN'], default: 'ACTIVE', required: true },
}, { timestamps: true });

// The replies of answers, oldest first.
replySchema.index({ answerId: 1, createdAt: 1 });

module.exports = mongoose.model('QuestionReply', replySchema);
