const mongoose = require('mongoose');

const moderationLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contentHash: { type: String, required: true },
  providerUsed: { type: String, required: true }, // e.g. "OpenAI", "Cloudflare", "RuleEngine", "Cache", "Multiple"
  model: { type: String, default: null },
  statusCode: { type: Number, default: null },
  responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
  openAiResult: { type: mongoose.Schema.Types.Mixed, default: null },
  llamaGuardResult: { type: mongoose.Schema.Types.Mixed, default: null },
  ruleEngineResult: { type: mongoose.Schema.Types.Mixed, default: null },
  finalDecision: { type: String, enum: ['APPROVE', 'REVIEW', 'REJECT', 'PENDING_REVIEW'], required: true },
  retryCount: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ModerationLog', moderationLogSchema);
