const mongoose = require('mongoose');

const launchRegionSchema = new mongoose.Schema({
  state: {
    type: String,
    required: true,
    trim: true
  },
  area: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['Supported', 'Beta', 'Coming Soon', 'Disabled'],
    required: true,
    default: 'Coming Soon'
  },
  active: {
    type: Boolean,
    default: true
  },
  geoBoundary: {
    type: Object, // Keeping for future use
    default: null
  },
  popupVersion: {
    type: Number,
    default: 1
  },
  popupTitleEn: {
    type: String,
    default: 'Humrah is here!'
  },
  popupBodyEn: {
    type: String,
    default: 'We are now available in your region.'
  },
  popupTitleHi: {
    type: String,
    default: 'हमराह यहाँ है!'
  },
  popupBodyHi: {
    type: String,
    default: 'हम अब आपके क्षेत्र में उपलब्ध हैं।'
  }
}, { timestamps: true });

// Ensure compound index for fast lookups
launchRegionSchema.index({ state: 1, area: 1 }, { unique: true });

module.exports = mongoose.model('LaunchRegion', launchRegionSchema);
