// models/EncryptionKey.js - Separate Encryption Key Storage
const mongoose = require('mongoose');

const encryptionKeySchema = new mongoose.Schema({
  keyId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Encrypted encryption key (yes, encrypted)
  key: {
    type: String,
    required: true,
    select: false // Never auto-select
  },
  
  // Key type
  createdFor: {
    type: String,
    enum: ['RANDOM_BOOKING', 'SUPPORT_CHAT'],
    required: true
  },
  
  // Access control
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
  
  // Lifecycle
  createdAt: {
    type: Date,
    default: Date.now,
    required: true
  },
  
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  
  // Deletion tracking
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  },
  
  deletedAt: {
    type: Date,
    default: null
  },
  
  // Access logging
  lastAccessedAt: {
    type: Date,
    default: null
  },
  
  accessCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES
// =============================================
encryptionKeySchema.index({ createdFor: 1, isDeleted: 1 });
encryptionKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL

// =============================================
// INSTANCE METHODS
// =============================================

/**
 * Check if user can access key
 */
encryptionKeySchema.methods.canAccess = function(userId, requiredLevel = 'READ') {
  const userAccess = this.accessibleBy.find(a => 
    a.userId.toString() === userId.toString()
  );
  
  if (!userAccess) return false;
  
  const levels = ['READ', 'WRITE', 'ADMIN'];
  const userLevelIndex = levels.indexOf(userAccess.accessLevel);
  const requiredLevelIndex = levels.indexOf(requiredLevel);
  
  return userLevelIndex >= requiredLevelIndex;
};

/**
 * Grant access to user
 */
encryptionKeySchema.methods.grantAccess = function(userId, accessLevel = 'READ') {
  // Remove existing access if any
  this.accessibleBy = this.accessibleBy.filter(a => 
    a.userId.toString() !== userId.toString()
  );
  
  // Add new access
  this.accessibleBy.push({
    userId,
    accessLevel,
    grantedAt: new Date()
  });
  
  return this.save();
};

/**
 * Revoke access from user
 */
encryptionKeySchema.methods.revokeAccess = function(userId) {
  this.accessibleBy = this.accessibleBy.filter(a => 
    a.userId.toString() !== userId.toString()
  );
  
  return this.save();
};

/**
 * Get decryption key (with access control)
 */
encryptionKeySchema.methods.getKey = async function(userId, requiredLevel = 'READ') {
  if (!this.canAccess(userId, requiredLevel)) {
    throw new Error('Access denied');
  }
  
  // Log access
  this.lastAccessedAt = new Date();
  this.accessCount++;
  await this.save();
  
  // Retrieve key (must explicitly select it)
  const keyDoc = await this.constructor.findById(this._id).select('+key');
  return keyDoc.key;
};

/**
 * Soft delete key
 */
encryptionKeySchema.methods.deleteKey = function() {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.key = null; // Clear the key
  return this.save();
};

// =============================================
// STATIC METHODS
// =============================================

/**
 * Create new encryption key
 */
encryptionKeySchema.statics.createKey = function(keyId, key, createdFor, expiresAt, participants = []) {
  const accessibleBy = participants.map(userId => ({
    userId,
    accessLevel: 'WRITE',
    grantedAt: new Date()
  }));
  
  return this.create({
    keyId,
    key,
    createdFor,
    expiresAt,
    accessibleBy
  });
};

/**
 * Find key by ID (admin only)
 */
encryptionKeySchema.statics.findByKeyId = function(keyId) {
  return this.findOne({ keyId, isDeleted: false });
};

/**
 * Cleanup expired keys
 */
encryptionKeySchema.statics.cleanupExpired = function() {
  return this.updateMany(
    {
      expiresAt: { $lt: new Date() },
      isDeleted: false
    },
    {
      $set: { 
        isDeleted: true,
        deletedAt: new Date(),
        key: null
      }
    }
  );
};

/**
 * Get access audit log for key
 */
encryptionKeySchema.statics.getAccessLog = async function(keyId) {
  const key = await this.findOne({ keyId })
    .populate('accessibleBy.userId', 'firstName lastName email role');
  
  if (!key) return null;
  
  return {
    keyId: key.keyId,
    createdFor: key.createdFor,
    accessCount: key.accessCount,
    lastAccessedAt: key.lastAccessedAt,
    accessibleBy: key.accessibleBy,
    isDeleted: key.isDeleted
  };
};

module.exports = mongoose.model('EncryptionKey', encryptionKeySchema);
