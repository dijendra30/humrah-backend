const mongoose = require('mongoose');

const featureInterestStatsSchema = new mongoose.Schema({
  feature: {
    type: String,
    required: true,
    index: true
  },
  city: {
    type: String,
    required: true,
    index: true
  },
  totalInterest: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Index to quickly query stats by feature and city
featureInterestStatsSchema.index({ feature: 1, city: 1 }, { unique: true });

module.exports = mongoose.model('FeatureInterestStats', featureInterestStatsSchema);
