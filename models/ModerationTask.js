// models/ModerationTask.js
const mongoose = require('mongoose');

const moderationTaskSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true 
  },
  documentType: { 
    type: String, 
    enum: ['profile', 'questionnaire'], 
    required: true 
  },
  fields: [{
    path: { type: String, required: true },
    value: { type: String, required: true }
  }],
  status: { 
    type: String, 
    enum: ['pending', 'processing', 'completed', 'failed', 'failed_permanently'], 
    default: 'pending',
    index: true
  },
  retryCount: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastError: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('ModerationTask', moderationTaskSchema);
