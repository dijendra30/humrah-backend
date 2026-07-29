// controllers/unifiedChatController.js
const Chat = require('../models/Chat');
const RandomBookingChat = require('../models/RandomBookingChat');
const MoodChat = require('../models/MoodChat');
const Message = require('../models/Message');

const getUnifiedChats = async (req, res) => {
  try {
    const userId = req.userId;
    
    // We will run queries in parallel
    const queries = [
      fetchStandardChats(userId),
      fetchRandomBookingChats(userId),
      fetchMoodChats(userId)
    ];

    const results = await Promise.allSettled(queries);
    
    let allChats = [];

    // Process Standard Chats
    if (results[0].status === 'fulfilled') {
      allChats = allChats.concat(results[0].value);
    } else {
      console.error('❌ Failed to fetch standard chats:', results[0].reason);
    }

    // Process Random Booking Chats
    if (results[1].status === 'fulfilled') {
      allChats = allChats.concat(results[1].value);
    } else {
      console.error('❌ Failed to fetch random booking chats:', results[1].reason);
    }

    // Process Mood Chats
    if (results[2].status === 'fulfilled') {
      allChats = allChats.concat(results[2].value);
    } else {
      console.error('❌ Failed to fetch mood chats:', results[2].reason);
    }

    // Sort all chats by lastMessageAt DESC
    allChats.sort((a, b) => {
      const timeA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const timeB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return timeB - timeA;
    });

    res.json({
      success: true,
      chats: allChats
    });

  } catch (error) {
    console.error('❌ Unified Chat Controller Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch unified chats' });
  }
};

// Helper: Fetch standard chats (FOUNDER, COMPANION, EVENT, etc.)
async function fetchStandardChats(userId) {
  const chats = await Chat.find({ 'participants.userId': userId })
    .populate({
      path: 'participants.userId',
      select: 'firstName lastName profilePhoto verified questionnaire'
    })
    .lean();

  return Promise.all(chats.map(async chat => {
    // Determine chat title/avatar based on other participants
    const otherParticipants = chat.participants.filter(p => 
      p.userId && p.userId._id.toString() !== userId.toString()
    );
    
    let title = chat.chatType;
    let avatar = null;
    let subtitle = undefined;
    let isOfficial = false;
    let showVerifiedBadge = false;
    let role = undefined;
    
    if (chat.chatType === 'FOUNDER') {
      title = 'Humrah Founder';
      avatar = 'HUMRAH_OFFICIAL_AVATAR'; // Sentinel value for the frontend to render the official logo
      subtitle = 'Official Humrah Support';
      isOfficial = true;
      showVerifiedBadge = true;
      role = 'FOUNDER';
    } else if (otherParticipants.length > 0) {
      const otherUser = otherParticipants[0].userId;
      title = `${otherUser.firstName || ''} ${otherUser.lastName || ''}`.trim() || chat.chatType;
      avatar = otherUser.profilePhoto || null;
    }

    // Optional: fetch last message for preview
    let lastMessageText = null;
    try {
      const lastMsg = await Message.findOne({ chatId: chat._id }).sort({ timestamp: -1 }).lean();
      if (lastMsg) lastMessageText = lastMsg.content;
    } catch (err) {
      console.error('Error fetching last message for Chat:', err);
    }

    // For map unread counts
    let unreadCount = 0;
    if (chat.unreadCounts && chat.unreadCounts[userId.toString()]) {
      unreadCount = chat.unreadCounts[userId.toString()];
    }

    return {
      chatId: chat._id,
      source: 'CHAT',
      chatType: chat.chatType,
      participants: chat.participants,
      title: title,
      avatar: avatar,
      lastMessage: lastMessageText,
      lastMessageAt: chat.lastMessageAt || chat.updatedAt || chat.createdAt,
      unreadCount: unreadCount,
      metadata: {
        status: chat.status,
        linkedReportId: chat.linkedReportId,
        linkedBookingId: chat.linkedBookingId,
        linkedFounderMessageIds: chat.linkedFounderMessageIds,
        isOfficial: isOfficial,
        showVerifiedBadge: showVerifiedBadge,
        role: role,
        subtitle: subtitle
      }
    };
  }));
}

// Helper: Fetch Random Booking Chats
async function fetchRandomBookingChats(userId) {
  const chats = await RandomBookingChat.find({ 'participants.userId': userId, isDeleted: false })
    .populate({
      path: 'participants.userId',
      select: 'firstName lastName profilePhoto verified questionnaire'
    })
    .populate('bookingId')
    .lean();

  return Promise.all(chats.map(async chat => {
    const otherParticipants = chat.participants.filter(p => 
      p.userId && p.userId._id.toString() !== userId.toString()
    );

    let title = 'Random Booking';
    let avatar = null;
    if (otherParticipants.length > 0) {
      const otherUser = otherParticipants[0].userId;
      title = `${otherUser.firstName || ''} ${otherUser.lastName || ''}`.trim();
      avatar = otherUser.profilePhoto || null;
    }

    let lastMessageText = null;
    try {
      const lastMsg = await Message.findOne({ chatId: chat._id }).sort({ timestamp: -1 }).lean();
      if (lastMsg) lastMessageText = lastMsg.content;
    } catch (err) {
      console.error('Error fetching last message for RandomBookingChat:', err);
    }

    return {
      chatId: chat._id,
      source: 'RANDOM_BOOKING',
      chatType: 'RANDOM_BOOKING',
      participants: chat.participants,
      title: title,
      avatar: avatar,
      lastMessage: lastMessageText,
      lastMessageAt: chat.lastMessageAt || chat.createdAt,
      unreadCount: 0,
      metadata: {
        status: chat.status,
        booking: chat.bookingId,
        expiresAt: chat.expiresAt
      }
    };
  }));
}

// Helper: Fetch Mood Chats
async function fetchMoodChats(userId) {
  const chats = await MoodChat.find({ 
    users: userId,
    active: true,
    expiresAt: { $gt: new Date() }
  })
    .populate({
      path: 'users',
      select: 'firstName lastName profilePhoto verified questionnaire'
    })
    .lean();

  return chats.map(chat => {
    const otherUsers = chat.users.filter(u => 
      u && u._id.toString() !== userId.toString()
    );

    let title = 'Mood Chat';
    let avatar = null;
    if (otherUsers.length > 0) {
      const otherUser = otherUsers[0];
      title = `${otherUser.firstName || ''} ${otherUser.lastName || ''}`.trim();
      avatar = otherUser.profilePhoto || null;
    }

    let lastMessageText = null;
    let lastMessageAt = chat.updatedAt || chat.createdAt;
    
    if (chat.messages && chat.messages.length > 0) {
      const lastMsg = chat.messages[chat.messages.length - 1];
      lastMessageText = lastMsg.text;
      lastMessageAt = lastMsg.createdAt;
    }

    const participants = chat.users.map(u => ({
      userId: u,
      role: 'USER'
    }));

    return {
      chatId: chat._id,
      source: 'MOOD',
      chatType: 'MOOD',
      participants: participants,
      title: title,
      avatar: avatar,
      lastMessage: lastMessageText,
      lastMessageAt: lastMessageAt,
      unreadCount: 0,
      metadata: {
        mood: chat.mood,
        vibeLevel: chat.vibeLevel,
        active: chat.active,
        expiresAt: chat.expiresAt
      }
    };
  });
}

module.exports = {
  getUnifiedChats
};
