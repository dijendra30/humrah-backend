const mongoose = require('mongoose');

const movieMessageSchema = new mongoose.Schema({
  sessionId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'MovieSession', 
    required: true,
    index: true 
  },
  senderId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    default: null 
  }, // null for system messages
  senderName: { 
    type: String, 
    required: true 
  },
  senderPhoto: { 
    type: String, 
    default: null 
  },
  type: { 
    type: String, 
    enum: ['text', 'voice', 'system'], 
    default: 'text',
    required: true 
  },
  text: { 
    type: String, 
    default: '' 
  },
  voiceUrl: { 
    type: String, 
    default: null 
  },
  duration: { 
    type: Number, 
    default: 0 
  }, // duration for voice notes in seconds
  replyTo: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'MovieMessage', 
    default: null 
  },
  clientMessageId: {
    type: String,
    default: null
  },
  // Edit / delete-for-everyone, as Sports chat does it (all additive, server-written):
  //   editedAt  set when the author edits a text message within 15 minutes.
  //   deletedAt / deletedBy  soft delete by the author: the row stays (replies,
  //             history order) but its text / voice URL are never returned again.
  editedAt:  { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Movie Hangout ticket check (additive). Set on the one system message that carries
  // the poll; clients that know it draw the poll card, older ones show the system text.
  pollId:    { type: mongoose.Schema.Types.ObjectId, ref: 'MovieTicketPoll', default: null },
  // A server-written system message that must exist at most once per session
  // ("MOVIE_TICKET_POLL:<sessionId>"). Unique per session where set (index below).
  systemKey: { type: String, default: null },
  readBy: [{
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  reactions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reaction: { type: String, enum: ['👍', '❤️', '😂', '😮', '😭'] }
  }],
  createdAt: { 
    type: Date, 
    default: Date.now,
    index: true
  }
}, { timestamps: false });

// At most one system message per (session, systemKey). Partial: only rows that HAVE
// a systemKey are indexed, so every existing message is untouched.
movieMessageSchema.index(
  { sessionId: 1, systemKey: 1 },
  { unique: true, partialFilterExpression: { systemKey: { $type: 'string' } } }
);

module.exports = mongoose.model('MovieMessage', movieMessageSchema);
