const mongoose = require('mongoose');

const officialEventSchema = new mongoose.Schema({
  title: { type: String, required: true },
  shortDescription: { type: String, required: true },
  description: { type: String, required: true },
  bannerImage: { type: String, required: true },
  galleryImages: {
    type: [String],
    validate: [arrayLimit, 'Gallery cannot exceed 5 images.']
  },
  category: {
    type: String,
    enum: [
      'Coffee Meetup', 'Movie Hangout', 'Board Games', 'Walking Group', 
      'Food Crawl', 'Music Night', 'Book Club', 'Networking', 
      'Workshop', 'Adventure', 'Community Service', 'Other'
    ],
    required: true
  },
  eventType: { type: String, default: 'Official' },
  
  // Date & Time
  date: { type: Date, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  
  // Location
  venueName: { type: String, required: true },
  address: { type: String, required: true },
  city: { type: String },
  district: { type: String },
  state: { type: String },
  latitude: { type: Number },
  longitude: { type: Number },
  
  // Details
  capacity: { type: Number, required: true },
  price: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' },
  
  // Host
  hostName: { type: String, default: 'Humrah Official' },
  hostPhoto: { type: String },
  
  // State
  status: {
    type: String,
    enum: ['Draft', 'Published', 'Expired', 'Cancelled'],
    default: 'Draft'
  },
  visibility: {
    type: String,
    enum: ['All Users', 'Verified Users Only'],
    default: 'All Users'
  },
  verificationRequirement: { type: Boolean, default: false },
  featureOnExplore: { type: Boolean, default: false },
  
  // Advanced Targeting
  targetAudience: {
    type: String,
    enum: ['All Users', 'Verified Users Only', 'Hosts Only', 'Members Only', 'Custom Filter'],
    default: 'All Users'
  },
  customFilters: {
    ageRange: { type: String, enum: ['18-24', '25-30', '30+', 'Any'], default: 'Any' },
    gender: { type: String, enum: ['Male', 'Female', 'Everyone'], default: 'Everyone' },
    minProfileCompletion: { type: Number, default: 0 }
  },
  geographicTargeting: {
    level: { type: String, enum: ['Entire India', 'State', 'District'], default: 'Entire India' },
    state: { type: String },
    district: { type: String }
  },
  
  // Analytics & Engagement
  joinedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  joinedCount: { type: Number, default: 0 },
  viewsCount: { type: Number, default: 0 },
  notificationsSent: { type: Number, default: 0 },
  notificationsOpened: { type: Number, default: 0 },
  
  stateWiseParticipation: { type: Map, of: Number, default: {} },
  districtWiseParticipation: { type: Map, of: Number, default: {} },

  // Admin Meta
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date }
}, { timestamps: true });

function arrayLimit(val) {
  return val.length <= 5;
}

module.exports = mongoose.model('OfficialEvent', officialEventSchema);
