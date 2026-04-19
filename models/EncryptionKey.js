// models/EncryptionKey.js - Separate Encryption Key Storage
const mongoose = require('mongoose');

const encryptionKeySchema = new mongoose.Schema({
  keyId: {
    type: String,
    required: true,
    unique: true,
    // ✅ FIX: index:true removed — unique:true already creates an index automatically
  },

  // Encrypted encryption key (never auto-selected)
  key: {
    type: String,
    required: true,
    select: false
  },

  createdFor: {
    type: String,
    enum: ['RANDOM_BOOKING', 'SUPPORT_CHAT'],
    required: true
  },

  accessibleBy: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    accessLevel: {
      type: String,
      enum: ['READ', 'WRITE', 'ADMIN']
    },
    grantedAt: {
      type: Date,
      default: Date.now
    }
  }],

  createdAt: {
    type: Date,
    default: Date.now,
    required: true
  },

  expiresAt: {
    type: Date,
    required: true,
    // ✅ FIX: index:true removed — the explicit TTL schema.index() below is the sole index.
    // Having both index:true AND schema.index({ expiresAt:1 }, { expireAfterSeconds:0 })
    // was creating two separate indexes on this field.
  },

  isDeleted: {
    type: Boolean,
    default: false,
    // ✅ FIX: index:true removed — covered by compound index({ createdFor, isDeleted }) below
  },

  deletedAt:      { type: Date, default: null },
  lastAccessedAt: { type: Date, default: null },
  accessCount:    { type: Number, default: 0 }

}, {
  timestamps: true
});

// =============================================
// INDEXES — single source of truth
// =============================================
encryptionKeySchema.index({ createdFor: 1, isDeleted: 1 });
encryptionKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL — sole expiresAt index

// =============================================
// INSTANCE METHODS
// =============================================

encryptionKeySchema.methods.canAccess = function(userId, requiredLevel = 'READ') {
  const userAccess = this.accessibleBy.find(a =>
    a.userId.toString() === userId.toString()
  );
  if (!userAccess) return false;
  const levels = ['READ', 'WRITE', 'ADMIN'];
  return levels.indexOf(userAccess.accessLevel) >= levels.indexOf(requiredLevel);
};

encryptionKeySchema.methods.grantAccess = function(userId, accessLevel = 'READ') {
  this.accessibleBy = this.accessibleBy.filter(a =>
    a.userId.toString() !== userId.toString()
  );
  this.accessibleBy.push({ userId, accessLevel, grantedAt: new Date() });
  return this.save();
};

encryptionKeySchema.methods.revokeAccess = function(userId) {
  this.accessibleBy = this.accessibleBy.filter(a =>
    a.userId.toString() !== userId.toString()
  );
  return this.save();
};

encryptionKeySchema.methods.getKey = async function(userId, requiredLevel = 'READ') {
  if (!this.canAccess(userId, requiredLevel)) throw new Error('Access denied');
  this.lastAccessedAt = new Date();
  this.accessCount++;
  await this.save();
  const keyDoc = await this.constructor.findById(this._id).select('+key');
  return keyDoc.key;
};

encryptionKeySchema.methods.deleteKey = function() {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.key = null;
  return this.save();
};

// =============================================
// STATIC METHODS
// =============================================

encryptionKeySchema.statics.createKey = function(keyId, key, createdFor, expiresAt, participants = []) {
  const accessibleBy = participants.map(userId => ({
    userId,
    accessLevel: 'WRITE',
    grantedAt: new Date()
  }));
  return this.create({ keyId, key, createdFor, expiresAt, accessibleBy });
};

encryptionKeySchema.statics.findByKeyId = function(keyId) {
  return this.findOne({ keyId, isDeleted: false });
};

encryptionKeySchema.statics.cleanupExpired = function() {
  return this.updateMany(
    { expiresAt: { $lt: new Date() }, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date(), key: null } }
  );
};

encryptionKeySchema.statics.getAccessLog = async function(keyId) {
  const key = await this.findOne({ keyId })
    .populate('accessibleBy.userId', 'firstName lastName email role');
  if (!key) return null;
  return {
    keyId:          key.keyId,
    createdFor:     key.createdFor,
    accessCount:    key.accessCount,
    lastAccessedAt: key.lastAccessedAt,
    accessibleBy:   key.accessibleBy,
    isDeleted:      key.isDeleted
  };
};

module.exports = mongoose.model('EncryptionKey', encryptionKeySchema);
