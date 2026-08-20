const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const User = require('./models/User');
  const VerificationSession = require('./models/VerificationSession');

  console.log('Connected to MongoDB. Running verification tests...');

  // Create test user
  const email = 'test_verify_' + Date.now() + '@example.com';
  const user = new User({ firstName: 'Test', lastName: 'Verify', email, password: 'password123', emailVerified: true });
  await user.save();
  console.log('Created test user:', user._id);

  // Set pending legacy photo
  user.verificationPhoto = 'https://example.com/photo.jpg';
  user.photoVerificationStatus = 'pending';
  user.verificationPhotoSubmittedAt = new Date();
  await user.save();
  console.log('Submitted legacy photo.');

  // Create pending session
  const sessionUser = new User({ firstName: 'Video', lastName: 'Test', email: 'video_' + Date.now() + '@example.com', password: 'password', emailVerified: false });
  await sessionUser.save();
  const session = new VerificationSession({ userId: sessionUser._id, sessionId: 'test_' + Date.now(), status: 'MANUAL_REVIEW', cloudinaryPublicId: 'test' });
  await session.save();
  console.log('Submitted video session.');
  
  // Test Analytics manually
  const totalUsers = await User.countDocuments({ role: 'USER' });
  const pendingSessionUserIds = await VerificationSession.distinct('userId', { status: 'MANUAL_REVIEW' });
  const legacyPendingOnly = await User.countDocuments({ _id: { $nin: pendingSessionUserIds }, photoVerificationStatus: 'pending', verificationPhoto: { $ne: null } });
  console.log('Legacy Pending Only Count:', legacyPendingOnly);
  console.log('Pending Session Users Count:', pendingSessionUserIds.length);

  // Test Queue logic
  const legacyUsers = await User.find({ 
    _id: { $nin: pendingSessionUserIds },
    photoVerificationStatus: 'pending', 
    verificationPhoto: { $ne: null } 
  }).sort({ verificationPhotoSubmittedAt: -1 }).limit(2);
  console.log('Queue Legacy Items:', legacyUsers.length);
  
  // Test approve logic
  user.photoVerificationStatus = 'approved';
  user.verified = user.isFullyVerified();
  console.log('User isFullyVerified result:', user.verified);
  
  // Cleanup
  await User.deleteMany({ email: { $regex: 'test_verify_|video_' } });
  await VerificationSession.deleteMany({ sessionId: { $regex: 'test_' } });
  
  process.exit(0);
}).catch(console.error);
