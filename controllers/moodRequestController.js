// controllers/moodRequestController.js
'use strict';

const MoodRequest      = require('../models/MoodRequest');
const MoodChat         = require('../models/MoodChat');
const MatchingTodayMood = require('../models/MatchingTodayMood');
const User             = require('../models/User');

const FCM_AVAILABLE = (() => {
  try { require('../config/firebase'); return true; } catch { return false; }
})();

async function safePush(userId, title, body, data = {}) {
  if (!FCM_AVAILABLE) return;
  try {
    const { sendPushToUser } = require('../services/notificationService');
    await sendPushToUser(userId.toString(), title, body, data);
  } catch (e) {
    console.error('❌ [MoodReq] push error:', e.message);
  }
}

// ── 1. SEND REQUEST ───────────────────────────────────────────────────────────
exports.sendRequest = async (req, res) => {
  try {
    const senderId   = req.userId;
    const { receiverId, message, requestSource } = req.body;

    if (!receiverId) return res.status(400).json({ success: false, message: 'receiverId required' });
    if (receiverId === senderId) return res.status(400).json({ success: false, message: 'Cannot request yourself' });

    // Sender must be live
    const senderMood = await MatchingTodayMood.findOne({ userId: senderId }).lean();
    const now = new Date();
    if (!senderMood?.visible || !senderMood?.expiresAt || new Date(senderMood.expiresAt) <= now) {
      return res.status(400).json({ success: false, message: 'Go live before sending a request' });
    }

    // No duplicate pending request
    const exists = await MoodRequest.findOne({
      senderId, receiverId,
      status:    'pending',
      expiresAt: { $gt: now },
    }).lean();
    if (exists) return res.status(409).json({ success: false, message: 'Request already pending' });

    const req_ = await MoodRequest.create({
      senderId,
      receiverId,
      mood:          senderMood.mood,
      vibeLevel:     senderMood.vibeLevel,
      message:       message?.trim().slice(0, 120) || null,
      requestSource: requestSource || 'mood_match',
      expiresAt:     senderMood.expiresAt,
    });

    // Realtime push to receiver
    const sender = await User.findById(senderId, 'firstName').lean();
    console.log(`[MoodReq] Request created: ${req_._id} by User ${senderId} for User ${receiverId}`);
    
    await safePush(
      receiverId,
      'New Companion Request 🤝',
      `${sender?.firstName ?? 'Someone'} wants to connect with you.`,
      {
        type:       'companion_request',
        requestId:  req_._id.toString(),
        screen:     'requests',
        senderId:   senderId.toString(),
        senderName: sender?.firstName ?? 'Someone',
        mood:       senderMood.mood       ?? '',
        vibeLevel:  senderMood.vibeLevel  ?? 'normal',
      }
    );
    console.log(`[MoodReq] FCM push sent to User ${receiverId}`);

    // Emit Socket.IO if io is available
    try {
      const { io } = require('../server');
      const payload = {
        requestId: req_._id.toString(),
        senderId:  senderId.toString(),
        senderName: sender?.firstName ?? 'Someone',
        firstName: sender?.firstName ?? 'Someone',
        mood:      senderMood.mood,
        vibeLevel: senderMood.vibeLevel,
        message:   req_.message,
      };
      
      io.to(`user:${receiverId}`).emit('mood:request', payload);
      // Forward compatibility
      io.to(`user:${receiverId}`).emit('new_companion_request', payload);
      
      console.log(`[MoodReq] Socket notification sent to User ${receiverId}`);
    } catch (e) {
      console.error('❌ [MoodReq] Socket emit failed:', e.message);
    }

    return res.json({ success: true, message: 'Request sent', requestId: req_._id });
  } catch (err) {
    console.error('❌ [MoodReq] sendRequest:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 2. GET INCOMING REQUESTS ──────────────────────────────────────────────────
exports.getIncoming = async (req, res) => {
  try {
    const now = new Date();
    const requests = await MoodRequest.find({
      receiverId: req.userId,
      status:     'pending',
      expiresAt:  { $gt: now },
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .populate('senderId', 'firstName profilePhoto verified photoVerificationStatus')
      .lean();

    const formatted = requests.map(r => ({
      requestId:   r._id,
      sender: {
        id:           r.senderId?._id,
        firstName:    r.senderId?.firstName,
        profilePhoto: r.senderId?.profilePhoto,
        verified:     r.senderId?.verified,
        photoVerified: r.senderId?.photoVerificationStatus === 'approved',
      },
      mood:      r.mood,
      vibeLevel: r.vibeLevel,
      message:   r.message,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));

    return res.json({ success: true, requests: formatted });
  } catch (err) {
    console.error('❌ [MoodReq] getIncoming:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 3. GET SENT REQUESTS ──────────────────────────────────────────────────────
exports.getSent = async (req, res) => {
  try {
    const now = new Date();
    const requests = await MoodRequest.find({
      senderId:  req.userId,
      expiresAt: { $gt: now },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('receiverId', 'firstName profilePhoto')
      .lean();

    const formatted = requests.map(r => ({
      requestId: r._id,
      receiver: {
        id:           r.receiverId?._id,
        firstName:    r.receiverId?.firstName,
        profilePhoto: r.receiverId?.profilePhoto,
      },
      status:    r.status,
      mood:      r.mood,
      createdAt: r.createdAt,
    }));

    return res.json({ success: true, requests: formatted });
  } catch (err) {
    console.error('❌ [MoodReq] getSent:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 4. ACCEPT REQUEST ─────────────────────────────────────────────────────────
exports.acceptRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const now = new Date();

    const moodReq = await MoodRequest.findOne({
      _id:        requestId,
      receiverId: req.userId,
      status:     'pending',
      expiresAt:  { $gt: now },
    });

    if (!moodReq) return res.status(404).json({ success: false, message: 'Request not found or expired' });

    // Create private chat room (or reuse if exists)
    let chat = await MoodChat.findOne({
      users:    { $all: [moodReq.senderId, moodReq.receiverId] },
      active:   true,
      requestId: moodReq._id,
    }).lean();

    if (!chat) {
      const chatExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h
      chat = await MoodChat.create({
        users:     [moodReq.senderId, moodReq.receiverId],
        mood:      moodReq.mood,
        vibeLevel: moodReq.vibeLevel,
        requestId: moodReq._id,
        expiresAt: chatExpiresAt,
      });
    }

    moodReq.status     = 'accepted';
    moodReq.chatRoomId = chat._id;
    moodReq.updatedAt  = now;
    await moodReq.save();

    // Notify sender
    await safePush(
      moodReq.senderId,
      'Your vibe request was accepted! ✨',
      'Start chatting safely.',
      { type: 'companion_request_accepted', chatRoomId: chat._id.toString(), screen: 'chats' }
    );
    console.log(`[MoodReq] FCM accept push sent to User ${moodReq.senderId}`);

    try {
      const { io } = require('../server');
      const payload = {
        chatRoomId: chat._id.toString(),
        requestId:  moodReq._id.toString(),
      };
      io.to(`user:${moodReq.senderId}`).emit('mood:accepted', payload);
      io.to(`user:${moodReq.senderId}`).emit('request_accepted', payload);
      console.log(`[MoodReq] Socket accept notification sent to User ${moodReq.senderId}`);
    } catch (e) {
      console.error('❌ [MoodReq] Socket emit accepted failed:', e.message);
    }

    return res.json({ success: true, chatRoomId: chat._id, message: 'Request accepted' });
  } catch (err) {
    console.error('❌ [MoodReq] acceptRequest:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 5. DECLINE REQUEST ────────────────────────────────────────────────────────
exports.declineRequest = async (req, res) => {
  try {
    const { requestId } = req.params;

    const moodReq = await MoodRequest.findOneAndUpdate(
      { _id: requestId, receiverId: req.userId, status: 'pending' },
      { $set: { status: 'declined', updatedAt: new Date() } },
      { new: true }
    );

    if (!moodReq) return res.status(404).json({ success: false, message: 'Request not found' });

    console.log(`[MoodReq] Request declined: ${requestId} by User ${req.userId}`);

    // Soft decline notification to sender
    await safePush(
      moodReq.senderId,
      'Update on your request',
      'The user is currently unavailable. Explore other vibes nearby!',
      { type: 'companion_request_declined', requestId: moodReq._id.toString(), screen: 'requests' }
    );
    console.log(`[MoodReq] FCM decline push sent to User ${moodReq.senderId}`);

    try {
      const { io } = require('../server');
      const payload = { requestId: moodReq._id.toString() };
      io.to(`user:${moodReq.senderId}`).emit('mood:declined', payload);
      io.to(`user:${moodReq.senderId}`).emit('request_declined', payload);
      console.log(`[MoodReq] Socket decline notification sent to User ${moodReq.senderId}`);
    } catch (e) {
      console.error('❌ [MoodReq] Socket emit declined failed:', e.message);
    }

    return res.json({ success: true, message: 'Request declined' });
  } catch (err) {
    console.error('❌ [MoodReq] declineRequest:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 6. GET CHAT ROOM ──────────────────────────────────────────────────────────
exports.getChatRoom = async (req, res) => {
  try {
    const { chatRoomId } = req.params;

    const chat = await MoodChat.findOne({
      _id:   chatRoomId,
      users: req.userId,
    })
      .populate('users', 'firstName profilePhoto verified photoVerificationStatus')
      .lean();

    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

    return res.json({ success: true, chat });
  } catch (err) {
    console.error('❌ [MoodReq] getChatRoom:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 7. SEND MESSAGE ───────────────────────────────────────────────────────────
exports.sendMessage = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const { text }       = req.body;

    if (!text?.trim()) return res.status(400).json({ success: false, message: 'text required' });

    const chat = await MoodChat.findOne({ _id: chatRoomId, users: req.userId, active: true });
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

    const msg = { senderId: req.userId, text: text.trim().slice(0, 500), createdAt: new Date() };
    chat.messages.push(msg);
    chat.updatedAt = new Date();
    await chat.save();

    // Realtime socket emit
    // FIX: emit 'new-message' to the chatRoomId room (not user personal room).
    // Android SocketManager only listens on 'new-message' from the room the user
    // joined via joinChat(). Field names match RandomBookingChat so MoodChatScreen
    // parses them with the same listener (reads 'content', 'timestamp'/'createdAt').
    const otherId = chat.users.find(u => u.toString() !== req.userId.toString());
    try {
      const { io } = require('../server');
      const msgId = chat.messages[chat.messages.length - 1]?._id?.toString() ?? chatRoomId;
      io.to(chatRoomId).emit('new-message', {
        _id:             msgId,
        chatId:          chatRoomId,
        senderId:        req.userId.toString(),
        content:         msg.text,           // Android reads 'content' not 'text'
        timestamp:       msg.createdAt.toISOString(),
        createdAt:       msg.createdAt.toISOString(),
        messageType:     'TEXT',
        isSystemMessage: false,
        deliveryStatus:  'SENT',
      });
    } catch {}

    // FCM push — always sent so app-killed/backgrounded users get the notification.
    // Socket.IO pingTimeout is 90 s, so guarding on isUserOnline blocks FCM for
    // 90 s after app kill. Android side suppresses if the chat screen is open.
    if (otherId) {
      try {
        const { sendDataFcm } = require('../utils/fcmHelper');
        const [recipient, sender] = await Promise.all([
          User.findById(otherId).select('fcmTokens'),
          User.findById(req.userId).select('firstName profilePhoto'),
        ]);
        if (recipient?.fcmTokens?.length > 0) {
          const msgId = chat.messages[chat.messages.length - 1]?._id?.toString() ?? chatRoomId;
          await sendDataFcm(otherId.toString(), recipient.fcmTokens, {
            type:            'NEW_CHAT_MESSAGE',
            chatId:          chatRoomId,
            chatType:        'MOOD',
            senderName:      sender?.firstName ?? 'Someone',
            senderPhotoUrl:  sender?.profilePhoto ?? '',
            messageText:     msg.text.substring(0, 100),
            messageId:       msgId,
            recipientUserId: otherId.toString(),
          });
        }
      } catch (pushErr) {
        console.error('[FCM] mood chat push error:', pushErr.message);
      }
    }

    return res.json({ success: true, message: msg });
  } catch (err) {
    console.error('❌ [MoodReq] sendMessage:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 8. GET MY CHAT ROOMS ──────────────────────────────────────────────────────
exports.getMyChatRooms = async (req, res) => {
  try {
    const chats = await MoodChat.find({
      users:  req.userId,
      active: true,
      expiresAt: { $gt: new Date() },
    })
      .sort({ updatedAt: -1 })
      .limit(20)
      .populate('users', 'firstName profilePhoto verified')
      .lean();

    return res.json({ success: true, chats });
  } catch (err) {
    console.error('❌ [MoodReq] getMyChatRooms:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
