const mongoose = require('mongoose');

const featureInterestUserSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  feature: {
    type: String,
    required: true
  },
  city: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// Atomic protection: ONE user = ONE count for a specific feature
featureInterestUserSchema.index({ userId: 1, feature: 1 }, { unique: true });

module.exports = mongoose.model('FeatureInterestUser', featureInterestUserSchema);
