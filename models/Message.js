// models/Message.js - Chat Message Model
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  // Chat reference
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat',
    required: true,
    index: true
  },
  
  // Sender information
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  senderRole: {
    type: String,
    enum: ['USER', 'SAFETY_ADMIN', 'SUPER_ADMIN'],
    required: true
  },
  
  // Message content
  content: {
    type: String,
    required: true,
    maxlength: 5000
  },
  
  // Message type
  messageType: {
    type: String,
    enum: ['TEXT', 'IMAGE', 'FILE', 'SYSTEM'],
    default: 'TEXT'
  },
  
  // Attachments
  attachments: [{
    url: String,
    publicId: String,
    fileType: String,
    fileName: String,
    fileSize: Number
  }],
  
  // Read status
  readBy: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    readAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // System message flag (for automated messages)
  isSystemMessage: {
    type: Boolean,
    default: false
  },
  
  // Admin-only flag (internal notes not visible to users)
  isInternalNote: {
    type: Boolean,
    default: false
  },
  
  // Deleted/edited status
  isDeleted: {
    type: Boolean,
    default: false
  },
  
  deletedAt: Date,
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  isEdited: {
    type: Boolean,
    default: false
  },
  
  editHistory: [{
    previousContent: String,
    editedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Reply reference
  replyTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message'
  },
  
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES
// =============================================
messageSchema.index({ chatId: 1, timestamp: -1 });
messageSchema.index({ senderId: 1, timestamp: -1 });
messageSchema.index({ isDeleted: 1 });

// =============================================
// INSTANCE METHODS
// =============================================
// Check if message is read by user
messageSchema.methods.isReadBy = function (userId) {
  return this.readBy.some(r => r.userId.toString() === userId.toString());
};

// Mark as read by user
messageSchema.methods.markAsReadBy = function (userId) {
  if (!this.isReadBy(userId)) {
    this.readBy.push({
      userId,
      readAt: new Date()
    });
  }
  return this.save();
};

// Edit message
messageSchema.methods.editContent = function (newContent) {
  this.editHistory.push({
    previousContent: this.content,
    editedAt: new Date()
  });
  
  this.content = newContent;
  this.isEdited = true;
  
  return this.save();
};

// Soft delete message
messageSchema.methods.softDelete = function (userId) {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.deletedBy = userId;
  return this.save();
};

// Check if sender is admin
messageSchema.methods.isFromAdmin = function () {
  return this.senderRole === 'SAFETY_ADMIN' || this.senderRole === 'SUPER_ADMIN';
};

// =============================================
// STATIC METHODS
// =============================================
// Get messages for chat
messageSchema.statics.findByChatId = function (chatId, limit = 50, skip = 0) {
  return this.find({
    chatId,
    isDeleted: false
  })
  .populate('senderId', 'firstName lastName profilePhoto role')
  .populate('replyTo', 'content senderId')
  .sort({ timestamp: -1 })
  .limit(limit)
  .skip(skip);
};

// Get unread messages for user in chat
messageSchema.statics.findUnreadForUser = function (chatId, userId) {
  return this.find({
    chatId,
    senderId: { $ne: userId },
    'readBy.userId': { $ne: userId },
    isDeleted: false
  });
};

// Count unread messages for user in chat
messageSchema.statics.countUnreadForUser = function (chatId, userId) {
  return this.countDocuments({
    chatId,
    senderId: { $ne: userId },
    'readBy.userId': { $ne: userId },
    isDeleted: false
  });
};

// Mark all messages as read for user in chat
messageSchema.statics.markAllAsReadForUser = async function (chatId, userId) {
  const messages = await this.find({
    chatId,
    senderId: { $ne: userId },
    'readBy.userId': { $ne: userId },
    isDeleted: false
  });
  
  const promises = messages.map(message => message.markAsReadBy(userId));
  return Promise.all(promises);
};

// =============================================
// PRE-SAVE HOOKS
// =============================================
// Update chat's lastMessageAt
messageSchema.post('save', async function (doc) {
  try {
    const Chat = mongoose.model('Chat');
    await Chat.findByIdAndUpdate(doc.chatId, {
      lastMessageAt: doc.timestamp
    });
  } catch (error) {
    console.error('Error updating chat lastMessageAt:', error);
  }
});

// Increment unread counts for other participants
messageSchema.post('save', async function (doc) {
  try {
    if (doc.isSystemMessage || doc.isInternalNote) return;
    
    const Chat = mongoose.model('Chat');
    const chat = await Chat.findById(doc.chatId);
    
    if (chat) {
      // Increment unread for all participants except sender
      chat.participants.forEach(participant => {
        if (participant.userId.toString() !== doc.senderId.toString() && participant.isActive) {
          chat.incrementUnread(participant.userId);
        }
      });
    }
  } catch (error) {
    console.error('Error incrementing unread counts:', error);
  }
});

// =============================================
// VIRTUAL PROPERTIES
// =============================================
// Get sender display name
messageSchema.virtual('senderDisplayName').get(function () {
  if (this.isFromAdmin()) {
    return 'Safety Team';
  }
  // This will be populated from senderId reference
  return this.populated('senderId') ? this.senderId.fullName : 'Unknown';
});

module.exports = mongoose.model('Message', messageSchema);
