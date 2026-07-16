const crypto = require('crypto');
const mongoose = require('mongoose');
require('dotenv').config();

async function test() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/humrah', { serverSelectionTimeoutMS: 5000 });
    console.log('✅ Connected to MongoDB');

    const User = require('./models/User');

    const email = 'test-reset-' + Date.now() + '@example.com';
    let user = new User({
      firstName: 'Test',
      lastName: 'User',
      email: email,
      password: 'OldPassword123!',
      role: 'USER'
    });
    await user.save();
    console.log('✅ User created:', email);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    console.log('Generated raw token:', rawToken);
    console.log('Stored hashed token:', hashedToken);

    const updateResult = await User.updateOne(
      { _id: user._id },
      {
        $set: {
          resetPasswordToken: hashedToken,
          resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000)
        }
      }
    );
    console.log('Update result:', updateResult);

    let dbUser = await User.findById(user._id).select('+resetPasswordToken +resetPasswordExpires');
    console.log('DB hashed token:', dbUser.resetPasswordToken);
    console.log('DB expiry:', dbUser.resetPasswordExpires);

    const incomingRawToken = rawToken;
    const incomingHashedToken = crypto.createHash('sha256').update(incomingRawToken).digest('hex');
    console.log('Incoming raw token:', incomingRawToken);
    console.log('Incoming hashed token:', incomingHashedToken);

    let lookupUser = await User.findOne({
      resetPasswordToken: incomingHashedToken
    }).select('+resetPasswordToken +resetPasswordExpires');
    
    if (!lookupUser) {
      console.log('❌ Lookup failed! No user found with token:', incomingHashedToken);
    } else {
      console.log('✅ Lookup successful! Found user:', lookupUser.email);
    }

    await User.deleteOne({ _id: user._id });
    console.log('Cleanup complete');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}
test();
