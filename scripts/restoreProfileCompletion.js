require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/humrah';

async function restore() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB.');

    const users = await User.find({});
    console.log(`Found ${users.length} users. Recalculating profile completion...`);

    let updatedCount = 0;
    for (const user of users) {
      // Because we added a pre('save') hook, simply calling user.save() 
      // will trigger the calculateProfileCompletion utility and save the right value.
      // However, to avoid triggering other pre('save') logic (like password hashing if not careful, 
      // though mongoose handles it), we can directly calculate it here.
      
      const { calculateProfileCompletion } = require('../utils/profileCompletion');
      const newCompleteness = calculateProfileCompletion(user);

      if (user.profileCompletion !== newCompleteness) {
        await User.updateOne({ _id: user._id }, { $set: { profileCompletion: newCompleteness } });
        updatedCount++;
      }
    }

    console.log(`Successfully updated ${updatedCount} users.`);
    process.exit(0);
  } catch (error) {
    console.error('Error during migration:', error);
    process.exit(1);
  }
}

restore();
