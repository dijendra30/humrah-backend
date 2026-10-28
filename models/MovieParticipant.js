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
  }],
  // Leave Hangout (additive). When this person left; null while they are in it.
  // Their own Sessions list keeps the hangout for 5 minutes after this, then never
  // again (movieMembershipService.LIST_GRACE_MS) — decided whenever the list is
  // read, so no timer can be lost. Rejoining clears it.
  leftAt: {
    type: Date,
    default: null
  },
  // "Delete" from my Sessions list (a closed chat only). This person's list only;
  // a later message in the chat would show it again (movieChatLifetime.hiddenFromList).
  hiddenAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

// Compound index for unique participants per session
movieParticipantSchema.index({ sessionId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('MovieParticipant', movieParticipantSchema);
