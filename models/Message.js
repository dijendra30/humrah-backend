// models/Message.js - FIXED for RandomBookingChat compatibility

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
  
  isSystemMessage: {
    type: Boolean,
    default: false
  },
  
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  
  readAt: {
    type: Date,
    default: null
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
messageSchema.index({ chatId: 1, isRead: 1 });

// =============================================
// POST-SAVE HOOKS (FIXED)
// =============================================

messageSchema.post('save', async function(doc) {
  try {
    // ✅ Try to find RandomBookingChat first
    const RandomBookingChat = mongoose.models.RandomBookingChat;
    
    if (RandomBookingChat) {
      const randomChat = await RandomBookingChat.findById(doc.chatId);
      
      if (randomChat) {
        randomChat.lastMessageAt = new Date();
        await randomChat.save();
        return; // Exit early if found
      }
    }
    
    // ✅ If not RandomBookingChat, try regular Chat
    const Chat = mongoose.models.Chat;
    
    if (Chat) {
      const chat = await Chat.findById(doc.chatId);
      
      if (chat) {
        chat.lastMessageAt = new Date();
        await chat.save();
      }
    }
  } catch (error) {
    // ✅ Don't throw error - just log it
    console.warn('Warning: Could not update chat lastMessageAt:', error.message);
  }
});

// Increment unread count hook
messageSchema.post('save', async function(doc) {
  try {
    // ✅ Skip for system messages
    if (doc.isSystemMessage) return;
    
    // ✅ Try RandomBookingChat first
    const RandomBookingChat = mongoose.models.RandomBookingChat;
    
    if (RandomBookingChat) {
      const randomChat = await RandomBookingChat.findById(doc.chatId);
      
      if (randomChat) {
        // RandomBookingChat doesn't have unread counts, skip
        return;
      }
    }
    
    // ✅ Try regular Chat
    const Chat = mongoose.models.Chat;
    
    if (Chat) {
      const chat = await Chat.findById(doc.chatId);
      
      if (chat && chat.participants) {
        // Increment unread count for participants who aren't the sender
        for (const participant of chat.participants) {
          if (participant.userId.toString() !== doc.senderId.toString()) {
            participant.unreadCount = (participant.unreadCount || 0) + 1;
          }
        }
        await chat.save();
      }
    }
  } catch (error) {
    // ✅ Don't throw error - just log it
    console.warn('Warning: Could not increment unread counts:', error.message);
  }
});

// =============================================
// INSTANCE METHODS
// =============================================

messageSchema.methods.markAsRead = function() {
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
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
    isRead: false,
    isDeleted: false
  });
};

messageSchema.statics.markChatAsRead = async function(chatId, userId) {
  await this.updateMany(
    {
      chatId,
      senderId: { $ne: userId },
      isRead: false,
      isDeleted: false
    },
    {
      $set: {
        isRead: true,
        readAt: new Date()
      }
    }
  );
};

messageSchema.statics.getRecentMessages = function(chatId, limit = 50) {
  return this.find({
    chatId,
    isDeleted: false
  })
  .sort({ timestamp: -1 })
  .limit(limit)
  .populate('senderId', 'firstName lastName profilePhoto');
};

messageSchema.statics.deleteOldMessages = function(daysOld = 90) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  
  return this.deleteMany({
    timestamp: { $lt: cutoffDate },
    isSystemMessage: false
  });
};

module.exports = mongoose.model('Message', messageSchema);
