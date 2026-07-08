const mongoose = require('mongoose');

const homeBannerSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subtitle: { type: String },
  bannerImage: { type: String, required: true },
  bannerImagePublicId: { type: String },
  
  actionType: { 
    type: String, 
    enum: ['None', 'Open URL', 'Open Internal Screen'], 
    default: 'None' 
  },
  actionValue: { type: String },
  
  displayOrder: { type: Number, default: 0 },
  publishDate: { type: Date, required: true },
  expiryDate: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
  
  // Analytics Tracking
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  ctr: { type: Number, default: 0 },
  lastViewedAt: { type: Date },
  lastClickedAt: { type: Date },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// Pre-save hook to calculate CTR (clicks / impressions * 100)
homeBannerSchema.pre('save', function(next) {
  if (this.impressions > 0) {
    this.ctr = parseFloat(((this.clicks / this.impressions) * 100).toFixed(2));
  } else {
    this.ctr = 0;
  }
  next();
});

// Indexes for optimized querying
homeBannerSchema.index({ isActive: 1, publishDate: 1, expiryDate: 1 });
homeBannerSchema.index({ displayOrder: 1 });

module.exports = mongoose.model('HomeBanner', homeBannerSchema);
