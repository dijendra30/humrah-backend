'use strict';

const FounderMessage = require('../models/FounderMessage');
const User = require('../models/User');
const { uploadBuffer, deleteImage } = require('../config/cloudinary');
const { notifyFounderChannel } = require('../services/telegramService');
const { validateWorkflowAction } = require('../utils/workflowValidator');
const { emitFounderEvent } = require('../services/founderNotificationService');
const { sendFounderEmailReply } = require('../services/founderEmailService');

/**
 * Helper to cleanup cloudinary uploads if DB save fails
 */
const cleanupUploads = async (attachments) => {
  if (!attachments || attachments.length === 0) return;
  for (const att of attachments) {
    try {
      await deleteImage(att.publicId);
    } catch (err) {
      console.error(`[FounderMessage] Failed to cleanup cloudinary asset ${att.publicId}`, err);
    }
  }
};

// ============================================================================
// USER ENDPOINTS
// ============================================================================

exports.submitMessage = async (req, res) => {
  let uploadedAttachments = [];
  try {
    const userId = req.user._id;
    const { category, subject, message, replyPreference, deviceInfo, appVersion } = req.body;

    // 1. Validation
    if (!category || !message || !replyPreference) {
      return res.status(400).json({ success: false, message: 'Category, message, and replyPreference are required.' });
    }
    
    if (message.length > 5000) {
      return res.status(400).json({ success: false, message: 'Message exceeds 5000 characters limit.' });
    }

    const allowedCategories = ['FEEDBACK', 'BUG', 'FEATURE_REQUEST', 'COMPLAINT', 'OTHER'];
    if (!allowedCategories.includes(category)) {
      return res.status(400).json({ success: false, message: 'Invalid category.' });
    }

    const allowedPreferences = ['NO_REPLY', 'EMAIL', 'FOLLOW_UP'];
    if (!allowedPreferences.includes(replyPreference)) {
      return res.status(400).json({ success: false, message: 'Invalid replyPreference.' });
    }

    // 2. Daily Rate Limit Check (Max 10 per day per user)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dailyCount = await FounderMessage.countDocuments({
      user: userId,
      createdAt: { $gte: startOfDay }
    });

    if (dailyCount >= 10) {
      return res.status(429).json({ success: false, message: 'Daily limit reached. You can only send 10 messages to the founder per day.' });
    }

    // 3. Process Uploads
    if (req.files && req.files.length > 0) {
      if (req.files.length > 2) {
        return res.status(400).json({ success: false, message: 'Maximum 2 attachments allowed.' });
      }
      
      for (const file of req.files) {
        // Validate MIME type
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/jpg'].includes(file.mimetype)) {
          return res.status(400).json({ success: false, message: 'Invalid file type. Only JPG, PNG, and WEBP are allowed.' });
        }
        
        // Validate Size (3MB)
        if (file.size > 3 * 1024 * 1024) {
          return res.status(400).json({ success: false, message: 'File size exceeds 3MB limit.' });
        }
      }

      for (const file of req.files) {
        const result = await uploadBuffer(file.buffer, 'founder_inbox');
        uploadedAttachments.push({
          url: result.url,
          publicId: result.publicId
        });
      }
    }

    // 4. Save to DB
    const newMessage = new FounderMessage({
      user: userId,
      userSnapshot: {
        name: `${req.user.firstName} ${req.user.lastName}`.trim(),
        email: req.user.email
      },
      category,
      subject,
      message,
      replyPreference,
      attachments: uploadedAttachments,
      deviceInfo,
      appVersion,
      ipAddress: req.ip
    });

    await newMessage.save();

    // 5. Fire and Forget Telegram Notification
    notifyFounderChannel(newMessage).catch(err => console.error('[Telegram] Founder Notification Error:', err));

    emitFounderEvent(userId, newMessage, 'MESSAGE_SUBMITTED').catch(err => {
      console.error('[FounderController] Notification error:', err.message);
    });

    res.status(201).json({
      success: true,
      message: 'Message sent successfully.',
      data: newMessage
    });

  } catch (error) {
    console.error('[FounderMessage] Error submitting message:', error);
    // Cleanup any uploaded images since the DB save failed
    if (uploadedAttachments.length > 0) {
      await cleanupUploads(uploadedAttachments);
    }
    res.status(500).json({ success: false, message: 'An error occurred while sending the message.' });
  }
};

exports.getUserMessages = async (req, res) => {
  try {
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const messages = await FounderMessage.find({ user: userId, isDeleted: false })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-internalNotes'); // Hide internal notes from user

    const total = await FounderMessage.countDocuments({ user: userId, isDeleted: false });

    res.status(200).json({
      success: true,
      message: 'Messages retrieved successfully.',
      data: messages,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('[FounderMessage] Error fetching user messages:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching messages.' });
  }
};

exports.getMessageDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const message = await FounderMessage.findOne({ _id: id, user: userId, isDeleted: false })
      .select('-internalNotes');

    if (!message) {
      return res.status(404).json({ success: false, message: 'Message not found.' });
    }

    res.status(200).json({
      success: true,
      message: 'Message retrieved successfully.',
      data: message
    });
  } catch (error) {
    console.error('[FounderMessage] Error fetching message details:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching message details.' });
  }
};

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

exports.listMessages = async (req, res) => {
  try {
    const { category, status, priority, isArchived, isStarred, search, startDate, endDate, page = 1, limit = 20, sort = 'createdAt', order = 'desc' } = req.query;

    let query = { isDeleted: false };

    if (category) query.category = category;
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (isArchived !== undefined) query.isArchived = isArchived === 'true';
    if (isStarred !== undefined) query.isStarred = isStarred === 'true';

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (search) {
      query.$or = [
        { subject: { $regex: search, $options: 'i' } },
        { message: { $regex: search, $options: 'i' } },
        { 'userSnapshot.name': { $regex: search, $options: 'i' } },
        { 'userSnapshot.email': { $regex: search, $options: 'i' } }
      ];
    }

    const sortOptions = {};
    sortOptions[sort] = order === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const messages = await FounderMessage.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit));

    const total = await FounderMessage.countDocuments(query);

    res.status(200).json({
      success: true,
      message: 'Messages retrieved successfully.',
      data: messages,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[FounderMessage] Admin List Error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.getMessageForAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    
    const message = await FounderMessage.findOne({ _id: id, isDeleted: false });
    if (!message) {
      return res.status(404).json({ success: false, message: 'Message not found.' });
    }

    // Auto-update to READING status if it was UNREAD
    let wasUnread = false;
    if (message.status === 'UNREAD') {
      message.status = 'READING';
      message.readTimestamp = new Date();
      await message.save();
      wasUnread = true;
    }

    if (wasUnread) {
      emitFounderEvent(message.user, message, 'MESSAGE_READ_WORKFLOW').catch(err => {
        console.error('[FounderController] Notification error:', err.message);
      });
    }

    res.status(200).json({
      success: true,
      message: 'Message retrieved successfully.',
      data: message
    });
  } catch (error) {
    console.error('[FounderMessage] Admin Get Message Error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.updateMessageStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, priority, isArchived, isStarred, isDeleted, internalNotes } = req.body;

    const message = await FounderMessage.findById(id);
    if (!message) {
      return res.status(404).json({ success: false, message: 'Message not found.' });
    }

    const previousStatus = message.status;

    if (status !== undefined) message.status = status;
    if (priority !== undefined) message.priority = priority;
    if (isArchived !== undefined) message.isArchived = isArchived;
    if (isStarred !== undefined) message.isStarred = isStarred;
    if (isDeleted !== undefined) message.isDeleted = isDeleted;
    if (internalNotes !== undefined) message.internalNotes = internalNotes;

    await message.save();

    if (previousStatus === 'UNREAD' && (status === 'READING' || status === 'READ' || status === 'REPLIED' || status === 'CLOSED')) {
      emitFounderEvent(message.user, message, 'MESSAGE_READ_WORKFLOW').catch(err => {
        console.error('[FounderController] Notification error:', err.message);
      });
    }

    res.status(200).json({
      success: true,
      message: 'Message updated successfully.',
      data: message
    });
  } catch (error) {
    console.error('[FounderMessage] Admin Update Error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

exports.replyToMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { replyText } = req.body;

    if (!replyText) {
      return res.status(400).json({ success: false, message: 'Reply text is required.' });
    }

    const message = await FounderMessage.findById(id);
    if (!message || message.isDeleted) {
      return res.status(404).json({ success: false, message: 'Message not found.' });
    }

    const validation = validateWorkflowAction(message.replyPreference, 'REPLY_BY_EMAIL');
    if (!validation.isValid) {
      return res.status(409).json({ success: false, message: validation.message });
    }

    if (message.emailStatus === 'SENDING' || message.emailStatus === 'SENT') {
      return res.status(409).json({ success: false, message: 'Email is already being sent or has been sent.' });
    }

    // Await provider confirmation as per requirements for synchronous sending
    await sendFounderEmailReply(id, replyText);

    res.status(200).json({
      success: true,
      message: 'Reply sent successfully.'
    });
  } catch (error) {
    console.error('[FounderMessage] Admin Reply Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error.' });
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    const [
      total, unread, reading, replied, closed,
      todayMessages, weeklyMessages, categoryStats
    ] = await Promise.all([
      FounderMessage.countDocuments({ isDeleted: false }),
      FounderMessage.countDocuments({ status: 'UNREAD', isDeleted: false }),
      FounderMessage.countDocuments({ status: 'READING', isDeleted: false }),
      FounderMessage.countDocuments({ status: 'REPLIED', isDeleted: false }),
      FounderMessage.countDocuments({ status: 'CLOSED', isDeleted: false }),
      FounderMessage.countDocuments({ 
        createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) },
        isDeleted: false
      }),
      FounderMessage.countDocuments({
        createdAt: { $gte: new Date(new Date().setDate(new Date().getDate() - 7)) },
        isDeleted: false
      }),
      FounderMessage.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ])
    ]);

    const breakdown = {};
    categoryStats.forEach(stat => {
      breakdown[stat._id] = stat.count;
    });

    res.status(200).json({
      success: true,
      message: 'Dashboard stats retrieved.',
      data: {
        total, unread, reading, replied, closed,
        todayMessages, weeklyMessages,
        categoryBreakdown: breakdown
      }
    });

  } catch (error) {
    console.error('[FounderMessage] Admin Stats Error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
