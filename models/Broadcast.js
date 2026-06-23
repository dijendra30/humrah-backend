const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  targetAudience: {
    type: String,
    required: true,
    // e.g., 'ALL_USERS', 'VERIFIED_USERS', 'UNVERIFIED_USERS', 'EXACT_PERCENTAGE:50', 'RANGE:50-70'
  },
  recipientCount: {
    type: Number,
    required: true,
    default: 0
  },
  sentBy: {
    type: String,
    default: 'admin'
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

const Broadcast = mongoose.model('Broadcast', broadcastSchema);
module.exports = Broadcast;
