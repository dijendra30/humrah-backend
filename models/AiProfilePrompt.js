const mongoose = require('mongoose');

const aiProfilePromptSchema = new mongoose.Schema({
  version: {
    type: Number,
    required: true,
    unique: true
  },
  promptText: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: false
  },
  reminderDays: {
    type: Number,
    default: 15
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Ensure only one prompt is active at a time
aiProfilePromptSchema.pre('save', async function(next) {
  if (this.isActive) {
    await this.constructor.updateMany({ _id: { $ne: this._id } }, { isActive: false });
  }
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('AiProfilePrompt', aiProfilePromptSchema);
