const mongoose = require('mongoose');

const officialEventSchema = new mongoose.Schema({
  // ── Basic Information ──────────────────────────────────────────────────────
  title: { type: String, required: true, trim: true },
  shortDescription: { type: String, required: true, maxlength: 200, trim: true },
  description: { type: String, required: true },
  category: {
    type: String,
    enum: [
      'Meetup', 'Workshop', 'Networking', 'Tech Event', 'Startup Event',
      'Cultural Event', 'Music Event', 'Food Festival', 'Exhibition',
      'Sports Event', 'Community Gathering', 'Seminar', 'Conference', 'Other'
    ],
    required: true
  },
  eventType: { type: String, default: 'Official' },

  // ── Organizer ──────────────────────────────────────────────────────────────
  organizerName: { type: String, default: 'Humrah Official' },
  organizerLogo: { type: String },         // Cloudinary URL
  organizerWebsite: { type: String },
  organizerEmail: { type: String },
  organizerPhone: { type: String },

  // ── Media ──────────────────────────────────────────────────────────────────
  bannerImage: { type: String, required: true },
  galleryImages: {
    type: [String],
    validate: [v => v.length <= 5, 'Gallery cannot exceed 5 images.']
  },

  // ── Date & Time ────────────────────────────────────────────────────────────
  date: { type: Date, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  registrationDeadline: { type: Date },
  timezone: { type: String, default: 'Asia/Kolkata' },
  scheduledPublishAt: { type: Date },       // used when status === 'Scheduled'

  // ── Location (Google Places) ───────────────────────────────────────────────
  venueName: { type: String, required: true },
  placeId: { type: String },
  formattedAddress: { type: String },
  coordinates: {
    type: [Number], // [longitude, latitude]
    default: [0, 0]
  },
  isManualLocation: { type: Boolean, default: false },
  fullAddress: { type: String },
  address: { type: String },                // backward-compat alias
  latitude: { type: Number },
  longitude: { type: Number },
  city: { type: String },
  district: { type: String },
  state: { type: String },
  country: { type: String, default: 'India' },
  pincode: { type: String },

  // ── Pricing ────────────────────────────────────────────────────────────────
  eventPriceType: { type: String, enum: ['Free', 'Paid'], default: 'Free' },
  price: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' },
  externalBookingUrl: { type: String },

  // ── Capacity ───────────────────────────────────────────────────────────────
  unlimitedSeats: { type: Boolean, default: false },
  capacity: { type: Number },               // null when unlimitedSeats = true
  waitlistEnabled: { type: Boolean, default: false },
  autoCloseRegistration: { type: Boolean, default: false },
  waitlistedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  waitlistCount: { type: Number, default: 0 },

  // ── Status ─────────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['Draft', 'Published', 'Scheduled', 'Expired', 'Cancelled'],
    default: 'Draft'
  },

  // ── Visibility ─────────────────────────────────────────────────────────────
  visibility: {
    type: String,
    enum: ['All Users', 'Verified Users Only'],
    default: 'All Users'
  },

  // ── Audience Filters ───────────────────────────────────────────────────────
  targetAudience: {
    type: String,
    enum: [
      'Everyone',
      'Verified Users Only',
      'Profile Completion > 70%',
      'Profile Completion > 90%',
      'Premium Users Only',
      'Custom Filter'
    ],
    default: 'Everyone'
  },
  customFilters: {
    ageRange: {
      type: String,
      enum: ['18-24', '25-30', '31-40', 'Custom Range', 'Any'],
      default: 'Any'
    },
    minAge: { type: Number },               // used when ageRange === 'Custom Range'
    maxAge: { type: Number },
    gender: {
      type: String,
      enum: ['All', 'Male', 'Female', 'Other'],
      default: 'All'
    },
    minProfileCompletion: { type: Number, default: 0 }
  },

  // ── Geographic Targeting ───────────────────────────────────────────────────
  geographicTargeting: {
    level: {
      type: String,
      enum: ['Entire India', 'State', 'State + District'],
      default: 'Entire India'
    },
    state: { type: String },
    district: { type: String }
  },

  // ── Feature Flags ──────────────────────────────────────────────────────────
  featuredEvent: { type: Boolean, default: false },
  featureOnExplore: { type: Boolean, default: false }, // backward compat
  pinOnExplore: { type: Boolean, default: false },
  sendNotification: { type: Boolean, default: false },
  showOnApp: { type: Boolean, default: true },

  // ── Analytics ──────────────────────────────────────────────────────────────
  joinedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  joinedCount: { type: Number, default: 0 },
  viewsCount: { type: Number, default: 0 },
  notificationsSent: { type: Number, default: 0 },
  notificationsOpened: { type: Number, default: 0 },
  stateWiseParticipation: { type: Map, of: Number, default: {} },
  districtWiseParticipation: { type: Map, of: Number, default: {} },

  // ── Admin Meta ─────────────────────────────────────────────────────────────
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date }

}, { timestamps: true });

officialEventSchema.index({ coordinates: "2dsphere" });

module.exports = mongoose.model('OfficialEvent', officialEventSchema);
