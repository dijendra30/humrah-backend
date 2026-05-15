// routes/messages.js - Message Routes
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Message = require('../models/Message');
const User = require('../models/User');

// @route   GET /api/messages/conversations
// @desc    Get all conversations
// @access  Private
router.get('/conversations', auth, async (req, res) => {
  try {
    const sentMessages = await Message.distinct('receiverId', { senderId: req.userId });
    const receivedMessages = await Message.distinct('senderId', { receiverId: req.userId });
    
    const conversationPartnerIds = [...new Set([...sentMessages, ...receivedMessages])];

    const conversations = await Promise.all(
      conversationPartnerIds.map(async (partnerId) => {
        const partner = await User.findById(partnerId)
          .select('firstName lastName profilePhoto lastActive');
        
        const lastMessage = await Message.findOne({
          $or: [
            { senderId: req.userId, receiverId: partnerId },
            { senderId: partnerId, receiverId: req.userId }
          ]
        }).sort({ createdAt: -1 });

        const unreadCount = await Message.countDocuments({
          senderId: partnerId,
          receiverId: req.userId,
          isRead: false
        });

        return {
          partner,
          lastMessage,
          unreadCount
        };
      })
    );

    conversations.sort((a, b) => 
      new Date(b.lastMessage?.createdAt) - new Date(a.lastMessage?.createdAt)
    );

    res.json({
      success: true,
      conversations
    });

  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   GET /api/messages/:userId
// @desc    Get messages with a specific user
// @access  Private
router.get('/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;

    const messages = await Message.find({
      $or: [
        { senderId: req.userId, receiverId: userId },
        { senderId: userId, receiverId: req.userId }
      ]
    })
    .sort({ createdAt: 1 })
    .limit(100);

    await Message.updateMany(
      { senderId: userId, receiverId: req.userId, isRead: false },
      { isRead: true }
    );

    res.json({
      success: true,
      messages
    });

  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   POST /api/messages
// @desc    Send a message
// @access  Private
router.post('/', auth, async (req, res) => {
  try {
    const { receiverId, content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Message content is required' 
      });
    }

    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return res.status(404).json({ 
        success: false, 
        message: 'Receiver not found' 
      });
    }

    const message = new Message({
      senderId: req.userId,
      receiverId,
      content: content.trim()
    });

    await message.save();

    res.status(201).json({
      success: true,
      message
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});


module.exports = router;
