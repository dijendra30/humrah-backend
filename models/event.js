// models/Event.js - Event Schema
const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: String,
  imageUrl: String,
  category: {
    type: String,
    enum: ['chill', 'festive', 'wellness', 'art', 'adventure', 'skill', 'thematic', 'comedy', 'music', 'talk', 'random', 'orphanage', 'gaming', 'hangout'],
    default: 'chill'
  },
  date: Date,
  location: String,
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  maxParticipants: {
    type: Number,
    default: 50
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

module.exports = mongoose.model('Event', eventSchema);