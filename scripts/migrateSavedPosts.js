// scripts/migrateSavedPosts.js
// Migration script to move bookmarks from User.savedPosts array into the new SavedPost collection.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const SavedPost = require('../models/SavedPost');
const Post = require('../models/Post');

async function runMigration() {
  console.log('--- Starting SavedPosts Migration ---');
  
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('Connected to MongoDB.');

    // Find users who have at least one saved post
    const usersWithSaves = await User.find({ 
      savedPosts: { $exists: true, $not: { $size: 0 } }
    }).select('savedPosts _id');

    console.log(`Found ${usersWithSaves.length} users with saved posts.`);

    let stats = {
      usersScanned: usersWithSaves.length,
      bookmarksDiscovered: 0,
      bookmarksMigrated: 0,
      invalidMissingPosts: 0,
      duplicatesSkipped: 0,
      failures: 0
    };

    for (const user of usersWithSaves) {
      for (const postId of user.savedPosts) {
        stats.bookmarksDiscovered++;

        try {
          // Verify post exists
          const postExists = await Post.exists({ _id: postId });
          if (!postExists) {
            stats.invalidMissingPosts++;
            continue;
          }

          // Upsert to SavedPost
          const existing = await SavedPost.findOne({ userId: user._id, postId: postId });
          if (existing) {
            stats.duplicatesSkipped++;
            continue;
          }

          await SavedPost.create({ userId: user._id, postId: postId });
          stats.bookmarksMigrated++;

        } catch (error) {
          if (error.code === 11000) {
            stats.duplicatesSkipped++;
          } else {
            console.error(`Failed to migrate save for user ${user._id} and post ${postId}:`, error);
            stats.failures++;
          }
        }
      }
    }

    console.log('\n--- Migration Complete ---');
    console.log(`Users scanned:          ${stats.usersScanned}`);
    console.log(`Bookmarks discovered:   ${stats.bookmarksDiscovered}`);
    console.log(`Bookmarks migrated:     ${stats.bookmarksMigrated}`);
    console.log(`Invalid/missing posts:  ${stats.invalidMissingPosts}`);
    console.log(`Duplicates skipped:     ${stats.duplicatesSkipped}`);
    console.log(`Failures:               ${stats.failures}`);
    console.log('\nNote: User.savedPosts arrays were NOT deleted. You can safely run this script multiple times.');

  } catch (error) {
    console.error('Fatal Migration Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
    process.exit(0);
  }
}

runMigration();
