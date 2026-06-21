const mongoose = require('mongoose');

const moderationCacheSchema = new mongoose.Schema({
  contentHash: { type: String, required: true, unique: true },
  decision: { type: String, enum: ['APPROVE', 'REVIEW', 'REJECT'], required: true },
  openAiResult: { type: mongoose.Schema.Types.Mixed, default: null },
  llamaGuardResult: { type: mongoose.Schema.Types.Mixed, default: null },
  ruleEngineResult: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, expires: 30 * 24 * 60 * 60 } // TTL 30 days
});

module.exports = mongoose.model('ModerationCache', moderationCacheSchema);
