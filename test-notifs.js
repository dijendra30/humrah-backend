require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Broadcast = require('./models/Broadcast');
const Notification = require('./models/Notification');
const ctrl = require('./controllers/notificationController');

// Mock req and res
const mockRes = () => {
  const res = {};
  res.status = jestFn().mockReturnValue(res);
  res.json = jestFn().mockReturnValue(res);
  return res;
};

function jestFn() {
  const mockFn = (...args) => {
    mockFn.calls.push(args);
    return mockFn.returnValue;
  };
  mockFn.calls = [];
  mockFn.mockReturnValue = (val) => {
    mockFn.returnValue = val;
    return mockFn;
  };
  return mockFn;
}

async function runTest() {
  console.log('Connecting to DB...');
  await mongoose.connect(process.env.MONGODB_URI);

  // 1. Setup Test Data
  const user = await User.findOne({});
  if (!user) throw new Error('No user found to test with.');

  const broadcast = await Broadcast.create({
    title: 'Test Notification Metadata',
    message: 'Testing FCM payload fields',
    type: 'ANNOUNCEMENT',
    audienceType: 'EVERYONE',
    language: 'en',
    createdBy: user._id,
    status: 'SENT'
  });

  const notification = await Notification.create({
    userId: user._id,
    title: broadcast.title,
    message: broadcast.message,
    type: 'ADMIN_BROADCAST',
    broadcastId: broadcast._id,
    isRead: false
  });

  console.log('--- TEST DATA CREATED ---');

  // 2. Test getUnreadCount
  let req = { user: { _id: user._id } };
  let res = mockRes();
  await ctrl.getUnreadCount(req, res);
  console.log('getUnreadCount response:', res.json.calls[0][0]);

  // 3. Test getNotifications
  req = { user: { _id: user._id }, query: { limit: 1 } };
  res = mockRes();
  await ctrl.getNotifications(req, res);
  console.log('getNotifications response:', res.json.calls[0][0].notifications[0]);

  // 4. Test markAsRead
  req = { user: { _id: user._id }, params: { id: notification._id.toString() } };
  res = mockRes();
  await ctrl.markAsRead(req, res);
  console.log('markAsRead response:', res.json.calls[0][0]);

  // Verify DB
  const updatedNotif = await Notification.findById(notification._id);
  console.log('Notification isRead in DB:', updatedNotif.isRead);

  const updatedBroadcast = await Broadcast.findById(broadcast._id);
  console.log('Broadcast openedCount in DB:', updatedBroadcast.openedCount);

  // 5. Test double read (should not increment)
  await ctrl.markAsRead(req, res);
  const updatedBroadcast2 = await Broadcast.findById(broadcast._id);
  console.log('Broadcast openedCount after double read:', updatedBroadcast2.openedCount);

  // Clean up
  await Notification.findByIdAndDelete(notification._id);
  await Broadcast.findByIdAndDelete(broadcast._id);
  console.log('--- TEST FINISHED ---');
  process.exit(0);
}

runTest().catch(console.error);
