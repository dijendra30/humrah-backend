// controllers/moodRequestController.js
'use strict';

const MoodRequest      = require('../models/MoodRequest');
const MoodChat         = require('../models/MoodChat');
const MatchingTodayMood = require('../models/MatchingTodayMood');
const User             = require('../models/User');
const personChat       = require('../services/personChatService');
const mongoose         = require('mongoose');

const FCM_AVAILABLE = (() => {
  try { require('../config/firebase'); return true; } catch { return false; }
})();

// The waving hand a People Nearby greeting opens with. Stored as its own plain
// text message so it stays a separate element from the words that follow; the
// client animates a message whose whole body is this emoji.
const GREETING_WAVE = '👋'; // 👋

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

    const now = new Date();
    const source = requestSource || 'mood_match';

    // People Nearby requests originate from proximity discovery, not from a live
    // mood session, so the "go live first" rule below does not apply to them.
    // Every other source — including every request the published app sends, which
    // never supplies requestSource and therefore always resolves to 'mood_match' —
    // keeps the original behaviour untouched.
    const isPeopleNearby = source === 'people_nearby';

    // ── Receiver validity + blocking (applies to ALL sources) ─────────────────
    // Discovery already filters blocked and inactive users out of the LIST, but a
    // crafted receiverId reaches this endpoint directly. This guard closes that
    // hole. It can only reject requests that discovery would never have surfaced,
    // so legitimate traffic from any client is unaffected.
    const receiver = await User.findById(receiverId, 'status blockedUsers').lean();
    if (!receiver) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (receiver.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, message: 'This user is not available' });
    }
    const receiverBlockedSender = (receiver.blockedUsers || [])
      .some(id => id.toString() === senderId.toString());
    if (receiverBlockedSender) {
      return res.status(403).json({ success: false, message: 'This user is not available' });
    }
    const sender = await User.findById(senderId, 'firstName blockedUsers').lean();
    const senderBlockedReceiver = (sender?.blockedUsers || [])
      .some(id => id.toString() === receiverId.toString());
    if (senderBlockedReceiver) {
      return res.status(403).json({ success: false, message: 'You have blocked this user' });
    }

    // ── Mood session gate — mood_match only ───────────────────────────────────
    let senderMood = null;
    if (!isPeopleNearby) {
      senderMood = await MatchingTodayMood.findOne({ userId: senderId }).lean();
      if (!senderMood?.visible || !senderMood?.expiresAt || new Date(senderMood.expiresAt) <= now) {
        return res.status(400).json({ success: false, message: 'Go live before sending a request' });
      }
    }

    // ── Existing active conversation — people_nearby only ────────────────────
    // If these two already have a live chat, tapping Chat must reopen it rather
    // than raise a second request. Scoped to people_nearby so the mood-match
    // path, which the published app uses, keeps its original behaviour exactly.
    if (isPeopleNearby) {
      // A conversation either person left is not "active": a new request (and its
      // acceptance) reopens that same chat. An older chat past its old expiry doesn't count.
      const activeChat = await MoodChat.findOne({
        users:       { $all: [senderId, receiverId] },
        active:      true,
        'leftBy.0':  { $exists: false },
        ...personChat.notLegacyExpired(now),
      }).select('_id').lean();

      if (activeChat) {
        return res.json({
          success:      true,
          message:      'Conversation already active',
          chatRoomId:   activeChat._id,
          alreadyActive: true,
        });
      }
    }

    // No duplicate pending request.
    // Still a 409 — the published app's contract is unchanged — but the existing
    // requestId is now included so a client can reopen that pending request
    // instead of treating a second tap as an error. Unknown fields are ignored
    // by older clients.
    const exists = await MoodRequest.findOne({
      senderId, receiverId,
      status:    'pending',
      expiresAt: { $gt: now },
    }).lean();
    if (exists) {
      return res.status(409).json({
        success:        false,
        message:        'Request already pending',
        requestId:      exists._id,
        alreadyPending: true,
      });
    }

    // `mood` and `expiresAt` are required by the MoodRequest schema, and `mood` is
    // also rendered directly by the existing Requests screen. Rather than relax
    // either field on a shared production collection, a People Nearby request
    // carries the literal label "Nearby" and its own fixed window. Mood-match
    // requests are untouched: they still take both values from the live session.
    const PEOPLE_NEARBY_MOOD_LABEL = 'Nearby';
    const PEOPLE_NEARBY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

    const req_ = await MoodRequest.create({
      senderId,
      receiverId,
      mood:          isPeopleNearby ? PEOPLE_NEARBY_MOOD_LABEL : senderMood.mood,
      vibeLevel:     isPeopleNearby ? 'normal' : senderMood.vibeLevel,
      message:       message?.trim().slice(0, 120) || null,
      requestSource: source,
      expiresAt:     isPeopleNearby ? new Date(now.getTime() + PEOPLE_NEARBY_TTL_MS) : senderMood.expiresAt,
    });

    // Realtime push to receiver — `sender` was already loaded by the block above.
    console.log(`[MoodReq] Request created: ${req_._id} by User ${senderId} for User ${receiverId} (source=${source})`);

    // Same FCM `type` as before, so the published app's handler is unchanged.
    // Only the human-readable title differs, because "Companion Request" would
    // misdescribe a request from a normal Member discovered via People Nearby.
    await safePush(
      receiverId,
      isPeopleNearby ? 'New Chat Request 👋' : 'New Companion Request 🤝',
      `${sender?.firstName ?? 'Someone'} wants to connect with you.`,
      {
        type:       'companion_request',
        requestId:  req_._id.toString(),
        screen:     'requests',
        senderId:   senderId.toString(),
        senderName: sender?.firstName ?? 'Someone',
        mood:       req_.mood      ?? '',
        vibeLevel:  req_.vibeLevel ?? 'normal',
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
        // Read from the created document, not from senderMood — the latter is
        // null for People Nearby requests, which have no mood session.
        mood:      req_.mood,
        vibeLevel: req_.vibeLevel,
        message:   req_.message,
      };
      
      io.to(`user:${receiverId}`).emit('mood:request', payload);
      // Forward compatibility
      io.to(`user:${receiverId}`).emit('new_companion_request', payload);
      
      console.log(`[MoodReq] Socket notification sent to User ${receiverId}`);
    } catch (e) {
      console.error('❌ [MoodReq] Socket emit failed:', e.message);
    }

    // `greeting` and `status` are additive: they let the new client render the
    // pending chat immediately from this response, with no follow-up fetch.
    return res.json({
      success:   true,
      message:   'Request sent',
      requestId: req_._id,
      status:    'pending',
      greeting:  req_.message,
    });
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
      // Additive: lets the client label a People Nearby request correctly instead
      // of calling every request a "Companion Request". Older clients that do not
      // declare this field simply ignore it.
      requestSource: r.requestSource || 'mood_match',
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
    if (!mongoose.isValidObjectId(requestId)) {
      return res.status(404).json({ success: false, message: 'Request not found or expired' });
    }

    // Blocked either way: never turns into a conversation.
    const pendingReq = await MoodRequest.findOne({ _id: requestId, receiverId: req.userId }).select('senderId status chatRoomId').lean();
    if (pendingReq && (await personChat.blockedBetween(req.userId, pendingReq.senderId)).any) {
      return res.status(403).json({ success: false, code: 'BLOCKED', message: 'This request is no longer available' });
    }

    // The one step that decides it: only the intended recipient, only a pending,
    // unexpired request, and only once — a second tap or a second device can't
    // create a second conversation.
    const moodReq = await MoodRequest.findOneAndUpdate(
      { _id: requestId, receiverId: req.userId, status: 'pending', expiresAt: { $gt: now } },
      { $set: { status: 'accepted', updatedAt: now } },
      { new: true }
    );

    if (!moodReq) {
      // Already accepted by this same person (a repeat tap): answer with the same chat.
      if (pendingReq && pendingReq.status === 'accepted' && pendingReq.chatRoomId) {
        return res.json({ success: true, chatRoomId: pendingReq.chatRoomId, message: 'Request accepted', alreadyAccepted: true });
      }
      return res.status(404).json({ success: false, message: 'Request not found or expired' });
    }

    // One conversation per pair: if these two already have one (even one that
    // someone left), it is reopened with its history — never a second chat. An older
    // chat past its old expiry stays closed and hidden; they get a fresh one instead.
    let chat = await MoodChat.findOne({
      users:  { $all: [moodReq.senderId, moodReq.receiverId], $size: 2 },
      active: true,
      ...personChat.notLegacyExpired(now),
    }).sort({ createdAt: -1 }).lean();

    if (chat) {
      // Reopened now, so it never expires from here on.
      await MoodChat.updateOne({ _id: chat._id },
        { $set: { leftBy: [], requestId: moodReq._id, updatedAt: now }, $unset: { expiresAt: 1 } });
    }

    if (!chat) {

      // A People Nearby greeting opens the conversation, attributed to the
      // sender — and it is TWO messages, not one: a wave, then the words. They
      // are stored as two ordinary text rows; the wave is the emoji on its own,
      // which the client renders with an animation. Nothing here needs a message
      // type, an attachment, or any schema change, and any other client simply
      // shows the emoji unanimated.
      //
      // Strictly scoped to requestSource === 'people_nearby'. Mood-match requests
      // DO carry a message (the published app sends an auto-generated "You both
      // seem open to … vibes today" line), so seeding on `message` alone would
      // have injected that sentence into every accepted mood-match chat, which
      // today opens empty. That path is left exactly as it was.
      //
      // Seeded only inside this creation branch, so the `findOne` reuse above can
      // never produce a second copy — accepting twice, reconnecting, or reopening
      // the chat all reuse the existing conversation untouched.
      const seeded = [];
      if (moodReq.requestSource === 'people_nearby' && moodReq.message) {
        seeded.push({ senderId: moodReq.senderId, text: GREETING_WAVE, createdAt: now });
        seeded.push({ senderId: moodReq.senderId, text: moodReq.message, createdAt: new Date(now.getTime() + 1) });
      }

      const chatDoc = {
        users:     [moodReq.senderId, moodReq.receiverId],
        mood:      moodReq.mood,
        vibeLevel: moodReq.vibeLevel,
        requestId: moodReq._id,
        // No expiresAt: one-to-one chats don't expire.
      };
      // Only add the field at all when there is something to seed, so the
      // mood-match create call is byte-identical to the original.
      if (seeded.length) chatDoc.messages = seeded;

      try {
        chat = await MoodChat.create(chatDoc);
      } catch (createErr) {
        // Give the request back so it can be accepted again — never "accepted" without a chat.
        await MoodRequest.updateOne({ _id: moodReq._id, status: 'accepted', chatRoomId: null },
          { $set: { status: 'pending', updatedAt: new Date() } });
        throw createErr;
      }
    }

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

    if (!mongoose.isValidObjectId(chatRoomId)) return res.status(404).json({ success: false, message: 'Chat not found' });
    const chat = await MoodChat.findOne({
      _id:   chatRoomId,
      users: req.userId,
    })
      .populate('users', 'firstName profilePhoto verified photoVerificationStatus')
      .lean();

    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

    // What this person sees: their hidden messages left out, deleted ones as a
    // placeholder, and whether they can still send (open chat, no block).
    const peer  = personChat.peerOf(chat, req.userId);
    const block = peer ? await personChat.blockedBetween(req.userId, peer._id || peer) : { any: false };
    return res.json({ success: true, chat: personChat.shapeChatFor(chat, req.userId, block) });
  } catch (err) {
    console.error('❌ [MoodReq] getChatRoom:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── 7. SEND MESSAGE ───────────────────────────────────────────────────────────
exports.sendMessage = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const { text, replyToId } = req.body;

    if (!text?.trim()) return res.status(400).json({ success: false, message: 'text required' });
    if (!mongoose.isValidObjectId(chatRoomId)) return res.status(404).json({ success: false, message: 'Chat not found' });

    const chat = await MoodChat.findOne({ _id: chatRoomId, users: req.userId, active: true });
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
    if (!personChat.isOpen(chat)) {
      return res.status(409).json({ success: false, code: 'CHAT_CLOSED', message: 'This chat has closed' });
    }
    // A block (either way) stops the conversation here, whatever the app shows.
    const peerId = personChat.peerOf(chat, req.userId);
    if (peerId && (await personChat.blockedBetween(req.userId, peerId)).any) {
      return res.status(403).json({ success: false, code: 'BLOCKED', message: 'You can no longer message this person' });
    }

    // Leave Conversation: nobody sends until an accepted request reopens it.
    const leftIds = personChat.leftIds(chat);
    if (leftIds.includes(req.userId.toString())) {
      return res.status(409).json({ success: false, code: 'LEFT', message: 'You left this conversation' });
    }
    if (leftIds.length) {
      return res.status(409).json({ success: false, code: 'PEER_LEFT', message: 'This person is no longer in this conversation' });
    }

    const msg = { senderId: req.userId, text: text.trim().slice(0, 500), createdAt: new Date() };
    const reply = personChat.replyReference(chat, replyToId, req.userId);
    if (reply) msg.replyTo = reply;
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
      console.log(`[MESSAGE_SAVED] Message saved to MongoDB for chat ${chatRoomId}`);
      const { io } = require('../server');
      const msgId = chat.messages[chat.messages.length - 1]?._id?.toString() ?? chatRoomId;
      const saved = chat.messages[chat.messages.length - 1];
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
        // Additive: the quoted message, for the new 1:1 chat screen.
        replyTo:         saved ? personChat.shapeMessage(saved.toObject(), personChat.messageMap(chat)).replyTo : null,
      });
      console.log(`[MESSAGE_BROADCAST] Message broadcasted to Socket room ${chatRoomId}`);
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
        // They muted this chat: the message is saved and shown live, just no push.
        const recipientMuted = (chat.mutedBy || []).some(u => u.toString() === otherId.toString());
        if (!recipientMuted && recipient?.fcmTokens?.length > 0) {
          const msgId = chat.messages[chat.messages.length - 1]?._id?.toString() ?? chatRoomId;
          await sendDataFcm(otherId.toString(), recipient.fcmTokens, {
            type:            'NEW_CHAT_MESSAGE',
            chatId:          chatRoomId,
            chatType:        'MOOD',
            senderName:      sender?.firstName ?? 'Someone',
            senderPhotoUrl:  sender?.profilePhoto ?? '',
            senderId:        req.userId.toString(),
            messageText:     msg.text.substring(0, 100),
            messageId:       msgId,
            recipientUserId: otherId.toString(),
          });
        }
      } catch (pushErr) {
        console.error('[FCM] mood chat push error:', pushErr.message);
      }
    }

    const savedMsg = chat.messages[chat.messages.length - 1];
    return res.json({
      success: true,
      message: savedMsg ? personChat.shapeMessage(savedMsg.toObject(), personChat.messageMap(chat)) : msg,
    });
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
      // A chat I left is no longer in my list; nor is an older chat past its old expiry.
      'leftBy.userId': { $ne: req.userId },
      ...personChat.notLegacyExpired(),
    })
      .sort({ updatedAt: -1 })
      .limit(20)
      .populate('users', 'firstName profilePhoto verified')
      .lean();

    // Each chat as this person sees it (no mute list, no hidden-by lists).
    const shaped = chats.map(c => personChat.shapeChatFor(c, req.userId, null));
    return res.json({ success: true, chats: shaped });
  } catch (err) {
    console.error('❌ [MoodReq] getMyChatRooms:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};


// ── 9. PERSON-TO-PERSON CHAT ACTIONS ──────────────────────────────────────────
// Thin handlers; every rule lives in services/personChatService.js.
const sendResult = (res, r, okBody) => r.ok
  ? res.status(r.status || 200).json({ success: true, ...okBody(r) })
  : res.status(r.status).json({ success: false, code: r.code, message: r.message });

exports.editMessage = async (req, res) => {
  try {
    const r = await personChat.editMessage(req.userId, req.params.chatRoomId, req.params.messageId, req.body?.text);
    return sendResult(res, r, x => ({ message: x.message }));
  } catch (err) {
    console.error('❌ [MoodReq] editMessage:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.deleteMessage = async (req, res) => {
  try {
    const scope = req.query?.scope || req.body?.scope;
    const r = await personChat.deleteMessage(req.userId, req.params.chatRoomId, req.params.messageId, scope);
    return sendResult(res, r, x => (x.hidden ? { hidden: true, messageId: x.messageId } : { message: x.message }));
  } catch (err) {
    console.error('❌ [MoodReq] deleteMessage:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.reactToMessage = async (req, res) => {
  try {
    const r = await personChat.reactToMessage(req.userId, req.params.chatRoomId, req.params.messageId, req.body?.emoji);
    return sendResult(res, r, x => ({ message: x.message }));
  } catch (err) {
    console.error('❌ [MoodReq] reactToMessage:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.setMuted = async (req, res) => {
  try {
    const r = await personChat.setMuted(req.userId, req.params.chatRoomId, req.body?.muted === true);
    return sendResult(res, r, x => ({ muted: x.muted }));
  } catch (err) {
    console.error('❌ [MoodReq] setMuted:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};


exports.leaveChat = async (req, res) => {
  try {
    const r = await personChat.leaveChat(req.userId, req.params.chatRoomId);
    return sendResult(res, r, x => ({ left: true, alreadyLeft: x.alreadyLeft, chatRoomId: x.chatRoomId }));
  } catch (err) {
    console.error('❌ [MoodReq] leaveChat:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
