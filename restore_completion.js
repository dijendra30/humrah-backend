require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const calculateProfileCompleteness = (questionnaire) => {
  if (!questionnaire) return 40;
  let completeness = 40;

  const isNullOrBlank = (str) => !str || str.trim().length === 0;
  const isNullOrEmpty = (arr) => !arr || arr.length === 0;

  // Basic Info
  if (!isNullOrBlank(questionnaire.ageGroup)) completeness += 10;

  // About You
  if (!isNullOrBlank(questionnaire.bio) ||
      !isNullOrBlank(questionnaire.goodMeetupMeaning) ||
      !isNullOrBlank(questionnaire.vibeQuote)) completeness += 10;

  // Lifestyle
  if (!isNullOrEmpty(questionnaire.comfortActivity) ||
      !isNullOrEmpty(questionnaire.relaxActivity) ||
      !isNullOrEmpty(questionnaire.musicPreference)) completeness += 10;

  // Hangout Prefs
  if (!isNullOrBlank(questionnaire.budgetComfort) ||
      !isNullOrEmpty(questionnaire.comfortZones) ||
      !isNullOrBlank(questionnaire.hangoutFrequency)) completeness += 10;

  // Companion Mode
  if (!isNullOrBlank(questionnaire.becomeCompanion)) {
      if (questionnaire.becomeCompanion === "Yes, I'm interested") {
          if (!isNullOrBlank(questionnaire.tagline) || !isNullOrEmpty(questionnaire.openFor)) {
              completeness += 10;
          }
      } else {
          completeness += 10;
      }
  }

  // Trust & Verification
  if (!isNullOrBlank(questionnaire.verifyIdentity) ||
      !isNullOrBlank(questionnaire.understandGuidelines)) completeness += 10;

  return Math.min(Math.max(completeness, 40), 100);
};

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/humrah', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    console.log('Connected to MongoDB. Migrating profile completions...');
    
    const users = await User.find({});
    let updatedCount = 0;
    
    for (const user of users) {
      const androidCalc = calculateProfileCompleteness(user.questionnaire);
      if (user.profileCompletion !== androidCalc) {
        user.profileCompletion = androidCalc;
        await User.updateOne({ _id: user._id }, { $set: { profileCompletion: androidCalc } });
        updatedCount++;
      }
    }
    
    console.log(`Successfully restored profile completion for ${updatedCount} users.`);
    process.exit(0);
  } catch (error) {
    console.error('Error during migration:', error);
    process.exit(1);
  }
};

run();
