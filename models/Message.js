// models/Message.js - WITH DELIVERY STATES (SENT → DELIVERED → READ)
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  senderRole: {
    type: String,
    enum: ['USER', 'ADMIN'],
    required: true
  },
  
  content: {
    type: String,
    required: true,
    maxlength: 5000
  },
  
  messageType: {
    type: String,
    enum: ['TEXT', 'IMAGE', 'FILE'],
    default: 'TEXT'
  },
  
  timestamp: {
    type: Date,
    default: Date.now,
    required: true,
    index: true
  },
  
  // ✅ DELIVERY STATE (STRICT)
  deliveryStatus: {
    type: String,
    enum: ['SENT', 'DELIVERED', 'READ'],
    default: 'SENT',
    required: true,
    index: true
  },
  
  // ✅ Delivered timestamp
  deliveredAt: {
    type: Date,
    default: null
  },
  
  // ✅ Read timestamp
  readAt: {
    type: Date,
    default: null
  },
  
  isSystemMessage: {
    type: Boolean,
    default: false
  },
  
  isDeleted: {
    type: Boolean,
    default: false
  },
  
  deletedAt: {
    type: Date,
    default: null
  },
  
  attachmentUrl: {
    type: String,
    default: null
  },
  
  attachmentType: {
    type: String,
    enum: ['IMAGE', 'DOCUMENT', 'VIDEO', null],
    default: null
  }
}, {
  timestamps: true
});

// =============================================
// INDEXES
// =============================================
messageSchema.index({ chatId: 1, timestamp: -1 });
messageSchema.index({ senderId: 1, timestamp: -1 });
messageSchema.index({ chatId: 1, deliveryStatus: 1 });

// =============================================
// POST-SAVE HOOKS
// =============================================

// Update chat lastMessageAt
messageSchema.post('save', async function(doc) {
  try {
    const RandomBookingChat = mongoose.models.RandomBookingChat;
    
    if (RandomBookingChat) {
      const randomChat = await RandomBookingChat.findById(doc.chatId);
      
      if (randomChat) {
        randomChat.lastMessageAt = new Date();
        await randomChat.save();
        return;
      }
    }
    
    const Chat = mongoose.models.Chat;
    
    if (Chat) {
      const chat = await Chat.findById(doc.chatId);
      
      if (chat) {
        chat.lastMessageAt = new Date();
        await chat.save();
      }
    }
  } catch (error) {
    console.warn('Warning: Could not update chat lastMessageAt:', error.message);
  }
});

// =============================================
// INSTANCE METHODS
// =============================================

messageSchema.methods.markDelivered = function() {
  if (this.deliveryStatus === 'SENT') {
    this.deliveryStatus = 'DELIVERED';
    this.deliveredAt = new Date();
    return this.save();
  }
  return Promise.resolve(this);
};

messageSchema.methods.markRead = function() {
  if (this.deliveryStatus === 'DELIVERED' || this.deliveryStatus === 'SENT') {
    this.deliveryStatus = 'READ';
    this.readAt = new Date();
    if (!this.deliveredAt) {
      this.deliveredAt = new Date();
    }
    return this.save();
  }
  return Promise.resolve(this);
};

messageSchema.methods.softDelete = function() {
  this.isDeleted = true;
  this.deletedAt = new Date();
  return this.save();
};

// =============================================
// STATIC METHODS
// =============================================

messageSchema.statics.getUnreadCount = function(chatId, userId) {
  return this.countDocuments({
    chatId,
    senderId: { $ne: userId },
    deliveryStatus: { $in: ['SENT', 'DELIVERED'] },
    isDeleted: false
  });
};

messageSchema.statics.getPendingMessages = function(chatId, userId) {
  return this.find({
    chatId,
    senderId: { $ne: userId },
    deliveryStatus: 'SENT',
    isDeleted: false
  })
  .populate('senderId', 'firstName lastName profilePhoto')
  .sort({ timestamp: 1 });
};

messageSchema.statics.markChatRead = async function(chatId, userId) {
  const result = await this.updateMany(
    {
      chatId,
      senderId: { $ne: userId },
      deliveryStatus: { $in: ['SENT', 'DELIVERED'] },
      isDeleted: false
    },
    {
      $set: {
        deliveryStatus: 'READ',
        readAt: new Date(),
        deliveredAt: new Date()
      }
    }
  );
  
  return result.modifiedCount;
};

messageSchema.statics.getRecentMessages = function(chatId, limit = 50) {
  return this.find({
    chatId,
    isDeleted: false
  })
  .populate('senderId', 'firstName lastName profilePhoto')
  .sort({ timestamp: -1 })
  .limit(limit);
};

module.exports = mongoose.model('Message', messageSchema);
