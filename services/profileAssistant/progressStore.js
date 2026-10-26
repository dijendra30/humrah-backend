// services/profileAssistant/progressStore.js
// ─────────────────────────────────────────────────────────────────────────────
// Evolution baseline: the one piece of Profile Assistant state that cannot be
// derived from data Humrah already keeps.
//
// Profile edits made through PUT /api/profile/me are already logged in
// ProfileEditLog, but the main questionnaire editor (PUT /api/users/me/questionnaire)
// keeps no history, and no completion snapshot exists anywhere. So the first time
// a user opens Evolution we record where their profile stood — completion
// percentage and the keys of the items still missing — and later visits compare
// against it. Nothing earlier is reconstructed or invented.
//
// Additive and isolated: its own small collection (one document per user, item
// keys only — no profile values), the same pattern as BioCache in
// routes/profileAssistant.js. No existing collection or field is touched. A
// document is removed automatically after a year without visits.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const mongoose = require('mongoose');

const progressSchema = new mongoose.Schema({
  userId:             { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  baselineAt:         { type: Date, required: true },
  baselinePercentage: { type: Number, required: true },
  baselineMissing:    { type: [String], default: [] },
  lastSeenAt:         { type: Date, default: Date.now, expires: 365 * 24 * 60 * 60 },
});

const ProfileAssistantProgress = mongoose.models.ProfileAssistantProgress
  || mongoose.model('ProfileAssistantProgress', progressSchema);

/**
 * Returns the user's baseline, creating it from `current` on the first visit.
 * @param {*} userId
 * @param {{percentage:number, missingKeys:string[]}} current
 * @returns {Promise<{baselineAt:Date, baselinePercentage:number, baselineMissing:string[], created:boolean}>}
 */
async function getOrCreateBaseline(userId, current, Model = ProfileAssistantProgress) {
  const now = new Date();
  const update = {
    $setOnInsert: {
      userId,
      baselineAt: now,
      baselinePercentage: current.percentage,
      baselineMissing: current.missingKeys,
    },
    $set: { lastSeenAt: now },
  };
  let doc;
  try {
    doc = await Model.findOneAndUpdate({ userId }, update, { upsert: true, new: true, lean: true });
  } catch (err) {
    // Two first visits at once: the unique index rejects the second insert. The
    // first one's baseline is the right one, so read it back.
    if (err && err.code === 11000) doc = await Model.findOne({ userId }).lean();
    else throw err;
  }
  return {
    baselineAt: doc.baselineAt,
    baselinePercentage: doc.baselinePercentage,
    baselineMissing: doc.baselineMissing || [],
    created: doc.baselineAt && doc.baselineAt.getTime() === now.getTime(),
  };
}

module.exports = { ProfileAssistantProgress, getOrCreateBaseline };
