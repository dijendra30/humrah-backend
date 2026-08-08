const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema({
  // Only one config document should exist
  logoUrl: {
    type: String,
    trim: true,
    default: ''
  },
  logoVersion: {
    type: Number,
    default: 1
  },
  draftLogoUrl: {
    type: String,
    trim: true,
    default: ''
  },
  draftCreatedAt: {
    type: Date,
    default: null
  },
  publishedAt: {
    type: Date,
    default: null
  },
  publishedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.model('AppConfig', appConfigSchema);
