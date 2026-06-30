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

module.exports = mongoose.model('MovieMessage', movieMessageSchema);
