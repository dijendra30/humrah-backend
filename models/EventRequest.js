const mongoose = require('mongoose');

const EventRequestSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    index: true 
  },
  title: { type: String, required: true },
  category: { type: String, required: true, index: true },
  description: { type: String, required: true },
  preferredDate: { type: String },
  preferredTime: { type: String },
  city: { type: String, required: true, index: true },
  venueSuggestion: { type: String },
  organizerName: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  extraMessage: { type: String },
  status: { 
    type: String, 
    enum: ['PENDING', 'CONTACTED', 'APPROVED', 'REJECTED'], 
    default: 'PENDING',
    index: true
  },
  adminNotes: { type: String },
  reviewedAt: { type: Date }
}, {
  timestamps: true
});

EventRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('EventRequest', EventRequestSchema);
