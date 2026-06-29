const mongoose = require('mongoose');

const movieParticipantSchema = new mongoose.Schema({
  sessionId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'MovieSession', 
    required: true,
    index: true 
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true 
  },
  joinedAt: { 
    type: Date, 
    default: Date.now 
  },
  lastSeenAt: { 
    type: Date, 
    default: Date.now 
  },
  unreadCount: { 
    type: Number, 
    default: 0 
  },
  // Local mute feature: array of user IDs that THIS participant has muted
  mutedUsers: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }]
}, { timestamps: true });

// Compound index for unique participants per session
movieParticipantSchema.index({ sessionId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('MovieParticipant', movieParticipantSchema);
