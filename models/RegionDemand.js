const mongoose = require('mongoose');

const regionDemandSchema = new mongoose.Schema({
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
  totalUsers: {
    type: Number,
    default: 1
  },
  firstRequestedAt: {
    type: Date,
    default: Date.now
  },
  lastRequestedAt: {
    type: Date,
    default: Date.now
  },
  lastUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

regionDemandSchema.index({ state: 1, area: 1 }, { unique: true });

module.exports = mongoose.model('RegionDemand', regionDemandSchema);
