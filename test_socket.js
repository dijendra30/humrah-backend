require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
const User = require('./models/User');
const MoodChat = require('./models/MoodChat');

const PORT = process.env.PORT || 10000;
const URL = `http://localhost:${PORT}`;
const SECRET = process.env.JWT_SECRET;

async function runTests() {
  console.log('--- STARTING E2E TEST ---');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Create Users A, B, C
  const userA = new User({ firstName: 'DeviceA', email: 'a@test.com', phone: '1111111111', role: 'user' });
  const userB = new User({ firstName: 'DeviceB', email: 'b@test.com', phone: '2222222222', role: 'user' });
  const userC = new User({ firstName: 'DeviceC', email: 'c@test.com', phone: '3333333333', role: 'user' });
  await Promise.all([userA.save(), userB.save(), userC.save()]);
  console.log(`Created test users: A=${userA._id}, B=${userB._id}, C=${userC._id}`);

  // Create Chat for A & B
  const chat = new MoodChat({
    users: [userA._id, userB._id],
    mood: 'test',
    expiresAt: new Date(Date.now() + 86400000)
  });
  await chat.save();
  const chatId = chat._id.toString();
  console.log(`Created chat room: ${chatId}`);

  // Generate tokens
  const tokenA = jwt.sign({ id: userA._id }, SECRET);
  const tokenB = jwt.sign({ id: userB._id }, SECRET);
  const tokenC = jwt.sign({ id: userC._id }, SECRET);

  // Connect Sockets
  const opts = (token) => ({
    transports: ['websocket'],
    auth: { token },
    reconnection: true
  });
  const socketA = io(URL, opts(tokenA));
  const socketB = io(URL, opts(tokenB));
  const socketC = io(URL, opts(tokenC));

  let receivedByA = 0;
  let receivedByB = 0;

  socketA.on('new-message', (msg) => {
    console.log(`\n>>> [DEVICE A] received new-message: ${msg.content}`);
    receivedByA++;
  });
  socketB.on('new-message', (msg) => {
    console.log(`\n>>> [DEVICE B] received new-message: ${msg.content}`);
    receivedByB++;
  });

  await new Promise(r => setTimeout(r, 1000)); // wait for connect

  // Test 4: Join authorization rejection
  console.log('\n--- TEST 4: Unauthorized Join ---');
  socketC.emit('join-chat', { chatId });
  await new Promise(r => setTimeout(r, 500));
  
  // Test 1 & 2: Valid Joins
  console.log('\n--- TEST 1 & 2 SETUP: Valid Joins ---');
  socketA.emit('join-chat', { chatId });
  socketB.emit('join-chat', { chatId });
  await new Promise(r => setTimeout(r, 500));

  async function sendMessageREST(token, text) {
    const res = await fetch(`${URL}/api/mood-request/chat/${chatId}/message`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    return res.json();
  }

  console.log('\n--- TEST 1: Device A sends message ---');
  await sendMessageREST(tokenA, 'hello');
  await new Promise(r => setTimeout(r, 500));

  console.log('\n--- TEST 2: Device B replies ---');
  await sendMessageREST(tokenB, 'hello ji.');
  await new Promise(r => setTimeout(r, 500));

  console.log('\n--- TEST 3: Disconnect B, Send from A, Reconnect B ---');
  socketB.disconnect();
  console.log('[DEVICE B] disconnected network.');
  await new Promise(r => setTimeout(r, 200));

  console.log('[DEVICE A] sends missed message.');
  await sendMessageREST(tokenA, 'you there?');
  await new Promise(r => setTimeout(r, 500));

  console.log('[DEVICE B] reconnecting...');
  socketB.connect();
  await new Promise(r => setTimeout(r, 500));
  socketB.emit('join-chat', { chatId }); // re-join room
  
  // REST fetch history
  const historyRes = await fetch(`${URL}/api/mood-request/chat/${chatId}`, {
    headers: { 'Authorization': `Bearer ${tokenB}` }
  });
  const historyData = await historyRes.json();
  const missedMessage = historyData.chat.messages[historyData.chat.messages.length - 1];
  console.log(`[DEVICE B] recovered message from REST: ${missedMessage.text}`);

  console.log('\n--- SUMMARY ---');
  console.log(`Device A received messages: ${receivedByA} (expected 2: one broadcast to self, one from B)`);
  console.log(`Device B received messages: ${receivedByB} (expected 2: one from A initially, one broadcast to self)`);

  // Cleanup
  await User.deleteMany({ _id: { $in: [userA._id, userB._id, userC._id] } });
  await MoodChat.deleteOne({ _id: chat._id });
  console.log('Cleanup complete.');
  
  process.exit(0);
}

runTests().catch(e => { console.error(e); process.exit(1); });
