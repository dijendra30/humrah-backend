// controllers/founderChatController.js
'use strict';

const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const FounderMessage = require('../models/FounderMessage');
const User = require('../models/User');
const { sendDataFcm } = require('../utils/fcmHelper');
const { validateWorkflowAction } = require('../utils/workflowValidator');
const { emitFounderEvent } = require('../services/founderNotificationService');

// Helper to get the official founder account (first SUPER_ADMIN)
async function getOfficialFounderUser() {
  let founder = await User.findOne({ role: 'SUPER_ADMIN' }).sort({ createdAt: 1 });
  return founder;
}

// ============================================================================
// ADMIN: Start Discussion
// ============================================================================
exports.startDiscussion = async (req, res) => {
  try {
    const { id } = req.params; // FounderMessage ID
    const adminId = req.user._id;

    const founderMessage = await FounderMessage.findById(id);
    if (!founderMessage || founderMessage.isDeleted) {
      return res.status(404).json({ success: false, message: 'Founder Message not found.' });
    }

    const validation = validateWorkflowAction(founderMessage.replyPreference, 'START_DISCUSSION');
    if (!validation.isValid) {
      return res.status(409).json({ success: false, message: validation.message });
    }

    const userId = founderMessage.user;

    // Check if an active Founder chat already exists for this user
    let chat = await Chat.findOne({
      chatType: 'FOUNDER',
      'participants.userId': userId,
      status: { $in: ['ACTIVE', 'WAITING_FOR_FOUNDER', 'WAITING_FOR_USER'] }
    });

    let isNewChat = false;

    if (chat) {
      // Add message reference if not already present
      if (!chat.linkedFounderMessageIds.includes(founderMessage._id)) {
        chat.linkedFounderMessageIds.push(founderMessage._id);
      }
      
      // Ensure the admin who clicked "Start Discussion" is assigned to the chat
      if (chat.assignedAdminId?.toString() !== adminId.toString()) {
        chat.assignedAdminId = adminId;
        await chat.save();
      }
    } else {
      isNewChat = true;
      // Get official founder account
      const officialFounder = await getOfficialFounderUser();
      const founderParticipantId = officialFounder ? officialFounder._id : adminId;

      // Create new Founder Chat
      chat = new Chat({
        chatType: 'FOUNDER',
        status: 'ACTIVE',
        participants: [
          { userId: userId, role: 'USER', isActive: true },
          { userId: founderParticipantId, role: 'SUPER_ADMIN', isActive: true }
        ],
        assignedAdminId: adminId,
        linkedFounderMessageIds: [founderMessage._id]
      });
      await chat.save();
    }

    // Update the FounderMessage status
    founderMessage.status = 'DISCUSSION_STARTED';
    await founderMessage.save();

    // System Message
    const systemContent = isNewChat 
      ? `A founder has started a discussion regarding your message: "${founderMessage.subject || founderMessage.category}".`
      : `Your message "${founderMessage.subject || founderMessage.category}" has been linked to this discussion.`;

    const sysMessage = await Message.create({
      chatId: chat._id,
      senderId: adminId,
      senderRole: 'ADMIN',
      content: systemContent,
      messageType: 'TEXT',
      isSystemMessage: true,
      deliveryStatus: 'SENT'
    });

    chat.lastMessageAt = new Date();
    await chat.save();

    // Socket Emit
    const io = req.app.get('io');
    if (io) {
      const payload = {
        _id: sysMessage._id.toString(),
        chatId: sysMessage.chatId.toString(),
        senderId: sysMessage.senderId.toString(),
        senderRole: sysMessage.senderRole,
        content: sysMessage.content,
        messageType: sysMessage.messageType,
        isSystemMessage: true,
        timestamp: sysMessage.timestamp.toISOString(),
        deliveryStatus: 'SENT'
      };
      io.to(chat._id.toString()).emit('new-message', payload);

      // Emit chat_updated to participants
      const notifyIds = chat.participants.map(p => p.userId.toString());
      if (chat.assignedAdminId) notifyIds.push(chat.assignedAdminId.toString());
      const allIds = [...new Set(notifyIds)];
      
      allIds.forEach(pId => {
        io.to(`user:${pId}`).emit('chat_updated', {
          chatId: chat._id.toString(),
          chatType: 'FOUNDER',
          lastMessage: sysMessage.content,
          lastMessageAt: chat.lastMessageAt.toISOString(),
          senderId: adminId.toString(),
          unreadCount: chat.unreadCounts.get(pId) || 0
        });
      });
    }

    // Emit DISCUSSION_READY notification
    await emitFounderEvent(userId.toString(), founderMessage, 'DISCUSSION_READY');

    res.status(200).json({
      success: true,
      message: isNewChat ? 'Discussion started.' : 'Linked to existing discussion.',
      chatId: chat._id
    });

  } catch (error) {
    console.error('[FounderChat] startDiscussion Error:', error);
    res.status(500).json({ success: false, message: 'Server error while starting discussion.' });
  }
};

// ============================================================================
// GET USER CHATS
// ============================================================================
exports.getUserChats = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;

    const chats = await Chat.find({
      chatType: 'FOUNDER',
      'participants.userId': userId,
      status: { $ne: 'ARCHIVED' }
    })
    .populate({ path: 'participants.userId', select: 'firstName lastName profilePhoto verified' })
    .populate({ path: 'linkedFounderMessageIds', select: 'category subject status' })
    .sort({ lastMessageAt: -1 });

    res.json({ success: true, chats });
  } catch (error) {
    console.error('[FounderChat] getUserChats Error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching chats.' });
  }
};

// ============================================================================
// GET MESSAGES
// ============================================================================
exports.getChatMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.userId || req.user?._id;

    const chat = await Chat.findById(chatId)
      .populate({ path: 'participants.userId', select: 'firstName lastName profilePhoto verified' });

    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found.' });

    const uid = userId.toString();
    const isParticipant = chat.participants.some(p => p.userId?._id?.toString() === uid || p.userId?.toString() === uid);
    const isAssignedAdmin = chat.assignedAdminId?.toString() === uid;
    if (!isParticipant && !isAssignedAdmin) return res.status(403).json({ success: false, message: 'Access denied.' });

    const messages = await Message.find({ chatId: chatId, isDeleted: false })
      .populate('senderId', 'firstName lastName profilePhoto')
      .sort({ timestamp: 1 }).limit(200);

    const transformed = messages.map(msg => ({
      _id: msg._id.toString(),
      chatId: msg.chatId.toString(),
      senderId: msg.senderId?._id?.toString() || msg.senderId.toString(),
      senderIdRaw: msg.senderId?._id ? {
        _id: msg.senderId._id.toString(),
        firstName: msg.senderId.firstName,
        lastName: msg.senderId.lastName,
        profilePhoto: msg.senderId.profilePhoto
      } : null,
      senderName: msg.senderId?.firstName ? `${msg.senderId.firstName} ${msg.senderId.lastName || ''}`.trim() : (msg.senderRole === 'ADMIN' ? 'Humrah Founder' : 'Unknown'),
      senderRole: msg.senderRole,
      content: msg.content,
      readBy: [],
      messageType: msg.messageType,
      isSystemMessage: msg.isSystemMessage,
      timestamp: msg.timestamp.toISOString(),
      deliveryStatus: msg.deliveryStatus,
      attachmentUrl: msg.attachmentUrl,
      attachmentType: msg.attachmentType
    }));

    res.json({ success: true, chat, messages: transformed });
  } catch (error) {
    console.error('[FounderChat] getChatMessages Error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching messages.' });
  }
};

// ============================================================================
// SEND MESSAGE
// ============================================================================
exports.sendMessage = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.userId || req.user?._id;
    const { content, messageType = 'TEXT', attachmentUrl = null, attachmentType = null } = req.body;

    if (!content?.trim() && !attachmentUrl) {
      return res.status(400).json({ success: false, message: 'Message content or attachment required.' });
    }

    const chat = await Chat.findById(chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found.' });
    if (chat.isReadOnly()) return res.status(403).json({ success: false, message: 'Chat is read-only.' });

    const uid = userId.toString();
    const isParticipant = chat.participants.some(p => p.userId.toString() === uid);
    const isAssignedAdmin = chat.assignedAdminId?.toString() === uid;
    
    if (!isParticipant && !isAssignedAdmin) return res.status(403).json({ success: false, message: 'Access denied.' });

    // Identify sender role (user vs admin)
    const senderRole = isAssignedAdmin ? 'ADMIN' : 'USER';
    
    let actualSenderId = userId;
    if (isAssignedAdmin) {
      const officialFounder = await getOfficialFounderUser();
      actualSenderId = officialFounder ? officialFounder._id : userId;
    }

    // Update status based on who replied
    chat.status = senderRole === 'ADMIN' ? 'WAITING_FOR_USER' : 'WAITING_FOR_FOUNDER';

    // Save message
    const message = await Message.create({
      chatId: chat._id,
      senderId: actualSenderId,
      senderRole: senderRole,
      content: content ? content.trim() : '',
      messageType: messageType,
      attachmentUrl: attachmentUrl,
      attachmentType: attachmentType,
      deliveryStatus: 'SENT'
    });

    chat.lastMessageAt = new Date();

    // Increment unread counts for all participants except the sender
    const senderIdStr = actualSenderId.toString();
    chat.participants.forEach(p => {
      const pIdStr = p.userId.toString();
      if (pIdStr !== senderIdStr) {
        const current = chat.unreadCounts.get(pIdStr) || 0;
        chat.unreadCounts.set(pIdStr, current + 1);
      }
    });
    if (chat.assignedAdminId && chat.assignedAdminId.toString() !== senderIdStr) {
      const adminIdStr = chat.assignedAdminId.toString();
      const current = chat.unreadCounts.get(adminIdStr) || 0;
      chat.unreadCounts.set(adminIdStr, current + 1);
    }

    await chat.save();

    // Format for socket
    const senderData = await User.findById(actualSenderId).select('firstName lastName profilePhoto');
    let socketSenderFirstName = senderData ? senderData.firstName : '';
    let socketSenderLastName = senderData ? senderData.lastName : '';
    let socketSenderPhoto = senderData ? senderData.profilePhoto : '';

    if (senderRole === 'ADMIN') {
      socketSenderFirstName = 'Humrah';
      socketSenderLastName = 'Founder';
      socketSenderPhoto = 'founder.png';
    }

    const payload = {
      _id: message._id.toString(),
      chatId: message.chatId.toString(),
      senderId: message.senderId.toString(),
      senderIdRaw: senderData ? {
        _id: senderData._id.toString(),
        firstName: socketSenderFirstName,
        lastName: socketSenderLastName,
        profilePhoto: socketSenderPhoto
      } : null,
      senderRole: message.senderRole,
      content: message.content,
      messageType: message.messageType,
      isSystemMessage: message.isSystemMessage,
      timestamp: message.timestamp.toISOString(),
      deliveryStatus: message.deliveryStatus,
      attachmentUrl: message.attachmentUrl,
      attachmentType: message.attachmentType
    };

    const io = req.app.get('io');
    if (io) {
      io.to(chatId).emit('new-message', payload);
    }

    // Push notification to all other participants (and assigned admin)
    const notifyIds = chat.participants.map(p => p.userId.toString());
    if (chat.assignedAdminId) notifyIds.push(chat.assignedAdminId.toString());
    
    // We notify everyone except the HTTP requester.
    // The HTTP requester will just get the 201 response.
    const uniqueNotifyIds = [...new Set(notifyIds)].filter(id => id !== uid);

    if (io) {
      // Emit chat_updated to all participants' personal rooms
      const allIds = [...new Set(notifyIds)];
      allIds.forEach(pId => {
        io.to(`user:${pId}`).emit('chat_updated', {
          chatId: chat._id.toString(),
          chatType: 'FOUNDER',
          lastMessage: message.content,
          lastMessageAt: chat.lastMessageAt.toISOString(),
          senderId: actualSenderId.toString(),
          unreadCount: chat.unreadCounts.get(pId) || 0
        });
      });
    }

    uniqueNotifyIds.forEach(async pId => {
      const recipient = await User.findById(pId).select('fcmTokens');
      if (recipient && recipient.fcmTokens && recipient.fcmTokens.length > 0) {
        sendDataFcm(pId, recipient.fcmTokens, {
          type: 'NEW_CHAT_MESSAGE',
          chatId: chatId,
          chatType: 'FOUNDER',
          senderName: senderRole === 'ADMIN' ? 'Humrah Founder' : (senderData ? senderData.firstName : 'User'),
          senderPhotoUrl: senderRole === 'ADMIN' ? 'founder.png' : (senderData ? senderData.profilePhoto : '')
        }).catch(err => console.error('[FCM] Founder chat push error:', err.message));
      }
    });

    res.status(201).json({ success: true, message: payload });
  } catch (error) {
    console.error('[FounderChat] sendMessage Error:', error);
    res.status(500).json({ success: false, message: 'Server error while sending message.' });
  }
};

// ============================================================================
// UPDATE CHAT STATUS
// ============================================================================
exports.updateChatStatus = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { status } = req.body;
    const adminId = req.user._id;

    if (!['ACTIVE', 'WAITING_FOR_FOUNDER', 'WAITING_FOR_USER', 'RESOLVED', 'CLOSED'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status.' });
    }

    const chat = await Chat.findById(chatId);
    if (!chat || chat.chatType !== 'FOUNDER') {
      return res.status(404).json({ success: false, message: 'Founder chat not found.' });
    }

    if (chat.assignedAdminId?.toString() !== adminId.toString()) {
        return res.status(403).json({ success: false, message: 'Access denied. You are not assigned to this chat.' });
    }

    chat.status = status;
    if (status === 'CLOSED' || status === 'RESOLVED') {
        chat.closedAt = new Date();
        chat.closedBy = adminId;
    }
    
    await chat.save();

    // System Message
    const sysMessage = await Message.create({
      chatId: chat._id,
      senderId: adminId,
      senderRole: 'ADMIN',
      content: status === 'RESOLVED' ? 'Discussion resolved.' : (status === 'CLOSED' ? 'Conversation closed.' : `Status updated to ${status}.`),
      messageType: 'TEXT',
      isSystemMessage: true,
      deliveryStatus: 'SENT'
    });

    const io = req.app.get('io');
    if (io) {
      io.to(chatId).emit('new-message', {
        _id: sysMessage._id.toString(),
        chatId: sysMessage.chatId.toString(),
        senderId: sysMessage.senderId.toString(),
        senderRole: sysMessage.senderRole,
        content: sysMessage.content,
        messageType: sysMessage.messageType,
        isSystemMessage: true,
        timestamp: sysMessage.timestamp.toISOString(),
        deliveryStatus: 'SENT'
      });
    }

    res.json({ success: true, message: 'Status updated.', chat });
  } catch (error) {
    console.error('[FounderChat] updateChatStatus Error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
