// models/User.js - Enhanced User Schema with Role-Based Access Control
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Questionnaire schema (unchanged)
const questionnaireSchema = new mongoose.Schema({
  // Onboarding fields
  name: String,
  city: String,
  languagePreference: String,
  hangoutPreferences: [String],
  availableTimes: [String],
  meetupPreference: String,
  lookingForOnHumrah: [String],
  vibeWords: [String],
  publicPlacesOnly: String,

  // Profile fields
  ageGroup: String,
  state: String,
  area: String,
  bio: String,
  goodMeetupMeaning: String,
  vibeQuote: String,
  comfortActivity: [String],
  relaxActivity: [String],
  musicPreference: [String],
  budgetComfort: String,
  comfortZones: [String],
  hangoutFrequency: String,

  // Companion mode
  becomeCompanion: String,
  openFor: [String],
  availability: String,
  price: String,
  tagline: String,

  // Trust & Safety
  verifyIdentity: String,
  understandGuidelines: String,

  // Legacy fields
  mood: String,
  personalityType: String,
  gender: String,
  dateOfBirth: String,
  language: String,
  interests: [String],
  hobbies: [String],
  movieGenre: String,
  favoriteFood: String,
  travelPreference: String,
  petPreference: String,
  fitnessLevel: String,
  smokingStatus: String,
  drinkingStatus: String,
  relationshipStatus: String,
  lookingFor: String,
  connectAndEarn: String,
  profession: String,
  education: String,
  income: String
}, { _id: false });

// =============================================
// ADMIN PERMISSIONS SUB-SCHEMA
// =============================================
const adminPermissionsSchema = new mongoose.Schema({
  // Report Management
  canViewReports: { type: Boolean, default: true },
  canManageReports: { type: Boolean, default: true },
  canAssignReports: { type: Boolean, default: true },
  
  // Chat Management
  canInitiateChats: { type: Boolean, default: true },
  canCloseChats: { type: Boolean, default: true },
  canViewAllChats: { type: Boolean, default: true },
  
  // User Moderation
  canWarnUsers: { type: Boolean, default: true },
  canSuspendUsers: { type: Boolean, default: false },
  canBanUsers: { type: Boolean, default: false },
  canRestrictUsers: { type: Boolean, default: true },
  
  // Admin Management (SUPER_ADMIN only)
  canManageAdmins: { type: Boolean, default: false },
  canViewAuditLogs: { type: Boolean, default: false },
  canConfigureSystem: { type: Boolean, default: false },
  
  // User Data Access
  canViewUserProfiles: { type: Boolean, default: true },
  canViewUserBookings: { type: Boolean, default: true },
  canExportData: { type: Boolean, default: false }
}, { _id: false });

// =============================================
// SUSPENSION INFO SUB-SCHEMA
// =============================================
const suspensionInfoSchema = new mongoose.Schema({
  isSuspended: { type: Boolean, default: false },
  suspendedAt: Date,
  suspendedUntil: Date,
  suspensionReason: String,
  suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  restrictions: {
    type: [String],
    enum: ['chat', 'booking', 'posting', 'commenting'],
    default: []
  },
  isAppealable: { type: Boolean, default: true },
  appealSubmitted: { type: Boolean, default: false },
  appealReason: String
}, { _id: false });

// =============================================
// MAIN USER SCHEMA
// =============================================
const userSchema = new mongoose.Schema({
  // Basic Information
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
  },
  password: {
    type: String,
    required: function () {
      return !this.googleId && !this.facebookId;
    },
    minlength: [6, 'Password must be at least 6 characters']
  },
  
  // =============================================
  // ROLE-BASED ACCESS CONTROL
  // =============================================
  role: {
    type: String,
    enum: ['USER', 'SAFETY_ADMIN', 'SUPER_ADMIN'],
    default: 'USER',
    required: true,
    index: true
  },
  
  // Admin-specific fields
  adminPermissions: {
    type: adminPermissionsSchema,
    default: null
  },
  
  // Account Status
  status: {
    type: String,
    enum: ['ACTIVE', 'SUSPENDED', 'BANNED', 'PENDING_VERIFICATION'],
    default: 'ACTIVE',
    index: true
  },
  
  // Suspension/Ban Information
  suspensionInfo: {
    type: suspensionInfoSchema,
    default: null
  },
  
  banInfo: {
    isBanned: { type: Boolean, default: false },
    bannedAt: Date,
    bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    banReason: String,
    isPermanent: { type: Boolean, default: false },
    bannedUntil: Date
  },
  
  // Profile & Verification
  profilePhoto: { type: String, default: null },
  profilePhotoPublicId: { type: String, default: null },

  questionnaire: {
    type: questionnaireSchema,
    default: {}
  },

  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },

  verified: { type: Boolean, default: false },
  emailVerified: { type: Boolean, default: false },

  // Photo Verification
  verificationPhoto: { type: String, default: null },
  verificationPhotoPublicId: { type: String, default: null },
  photoVerificationStatus: { 
    type: String, 
    enum: ['not_submitted', 'pending', 'approved', 'rejected'],
    default: 'not_submitted'
  },
  verificationPhotoSubmittedAt: { type: Date, default: null },
  photoVerifiedAt: { type: Date, default: null },
  photoVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // OTP Email Verification
  emailVerificationOTP: { type: String, default: null },
  emailVerificationExpires: { type: Date, default: null },

  // OAuth
  googleId: String,
  facebookId: String,

  // Activity Tracking
  lastActive: { type: Date, default: Date.now },
  loginAttempts: { type: Number, default: 0 },
  lockUntil: Date,
  
  // Admin Tracking
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  adminNotes: [{
    note: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
  }],
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// =============================================
// INDEXES FOR PERFORMANCE
// =============================================
userSchema.index({ email: 1 });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ 'suspensionInfo.isSuspended': 1 });
userSchema.index({ 'banInfo.isBanned': 1 });

// =============================================
// PRE-SAVE HOOKS
// =============================================
// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Update timestamp
userSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Set default admin permissions based on role
userSchema.pre('save', function (next) {
  if (this.isModified('role')) {
    if (this.role === 'SAFETY_ADMIN') {
      this.adminPermissions = {
        canViewReports: true,
        canManageReports: true,
        canAssignReports: true,
        canInitiateChats: true,
        canCloseChats: true,
        canViewAllChats: true,
        canWarnUsers: true,
        canSuspendUsers: true,
        canBanUsers: false,
        canRestrictUsers: true,
        canManageAdmins: false,
        canViewAuditLogs: false,
        canConfigureSystem: false,
        canViewUserProfiles: true,
        canViewUserBookings: true,
        canExportData: false
      };
    } else if (this.role === 'SUPER_ADMIN') {
      this.adminPermissions = {
        canViewReports: true,
        canManageReports: true,
        canAssignReports: true,
        canInitiateChats: true,
        canCloseChats: true,
        canViewAllChats: true,
        canWarnUsers: true,
        canSuspendUsers: true,
        canBanUsers: true,
        canRestrictUsers: true,
        canManageAdmins: true,
        canViewAuditLogs: true,
        canConfigureSystem: true,
        canViewUserProfiles: true,
        canViewUserBookings: true,
        canExportData: true
      };
    } else {
      this.adminPermissions = null;
    }
  }
  next();
});

// =============================================
// INSTANCE METHODS
// =============================================
// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Check if fully verified
userSchema.methods.isFullyVerified = function () {
  return this.emailVerified && this.photoVerificationStatus === 'approved';
};

// Check if account is locked
userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

// Increment login attempts
userSchema.methods.incLoginAttempts = function () {
  // Reset if lock expired
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $set: { loginAttempts: 1 },
      $unset: { lockUntil: 1 }
    });
  }
  
  // Increment attempts
  const updates = { $inc: { loginAttempts: 1 } };
  
  // Lock account after 5 attempts
  const maxAttempts = 5;
  const lockTime = 2 * 60 * 60 * 1000; // 2 hours
  
  if (this.loginAttempts + 1 >= maxAttempts && !this.isLocked()) {
    updates.$set = { lockUntil: Date.now() + lockTime };
  }
  
  return this.updateOne(updates);
};

// Reset login attempts
userSchema.methods.resetLoginAttempts = function () {
  return this.updateOne({
    $set: { loginAttempts: 0 },
    $unset: { lockUntil: 1 }
  });
};

// Check if user has specific permission
userSchema.methods.hasPermission = function (permission) {
  if (this.role === 'USER') return false;
  if (this.role === 'SUPER_ADMIN') return true; // Super admin has all permissions
  
  return this.adminPermissions && this.adminPermissions[permission] === true;
};

// Check if user can perform action
userSchema.methods.canPerformAction = function (action) {
  if (this.status !== 'ACTIVE') return false;
  if (this.suspensionInfo?.isSuspended) return false;
  if (this.banInfo?.isBanned) return false;
  
  // Check specific restrictions
  if (this.suspensionInfo?.restrictions?.includes(action)) return false;
  
  return true;
};

// =============================================
// STATIC METHODS
// =============================================
// Find active users
userSchema.statics.findActive = function () {
  return this.find({ status: 'ACTIVE' });
};

// Find by role
userSchema.statics.findByRole = function (role) {
  return this.find({ role });
};

// Find admins
userSchema.statics.findAdmins = function () {
  return this.find({ role: { $in: ['SAFETY_ADMIN', 'SUPER_ADMIN'] } });
};

// =============================================
// VIRTUAL PROPERTIES
// =============================================
// Full name
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Is admin
userSchema.virtual('isAdmin').get(function () {
  return this.role === 'SAFETY_ADMIN' || this.role === 'SUPER_ADMIN';
});

// Is super admin
userSchema.virtual('isSuperAdmin').get(function () {
  return this.role === 'SUPER_ADMIN';
});

// Profile completeness
userSchema.virtual('profileCompleteness').get(function () {
  if (!this.questionnaire) return 40;

  const q = this.questionnaire;
  let score = 40;

  if (q.ageGroup) score += 3;
  if (q.state) score += 3;
  if (q.area) score += 4;
  if (q.bio) score += 4;
  if (q.goodMeetupMeaning) score += 3;
  if (q.vibeQuote) score += 3;
  if (q.comfortActivity) score += 3;
  if (q.relaxActivity) score += 3;
  if (q.musicPreference) score += 4;
  if (q.budgetComfort) score += 3;
  if (q.comfortZones && q.comfortZones.length > 0) score += 4;
  if (q.hangoutFrequency) score += 3;

  if (q.becomeCompanion === "Yes! I'd love to connect and earn 💰") {
    if (q.openFor && q.openFor.length > 0) score += 3;
    if (q.availability) score += 2;
    if (q.price) score += 2;
    if (q.tagline) score += 3;
  } else if (q.becomeCompanion) {
    score += 10;
  }

  if (q.verifyIdentity) score += 5;
  if (q.understandGuidelines) score += 5;

  return Math.min(score, 100);
});

// =============================================
// SANITIZE OUTPUT
// =============================================
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailVerificationOTP;
  delete obj.loginAttempts;
  delete obj.lockUntil;
  
  // Hide admin notes from non-admins
  if (obj.role === 'USER') {
    delete obj.adminNotes;
  }
  
  return obj;
};

module.exports = mongoose.model('User', userSchema);
