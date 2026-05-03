// models/OrphanageClick.js
// Persists every tap on the "Visit Orphanage" coming-soon card.
// Fields saved: userId (ref to User), name, email (pulled server-side from User),
//               source, action, deviceTs (client ISO timestamp), timestamps.

const mongoose = require('mongoose');

const orphanageClickSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true
    },
    name:     { type: String, default: '' },  // display name at time of click
    email:    { type: String, default: '' },  // email at time of click
    action:   { type: String, default: 'orphanage_click' },
    source:   { type: String, default: 'home_screen' },
    deviceTs: { type: String, default: '' }   // ISO-8601 sent by Android client
  },
  { timestamps: true }
);

// Auto-purge records older than 1 year (optional — remove index to keep forever)
orphanageClickSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31_536_000 });

module.exports = mongoose.model('OrphanageClick', orphanageClickSchema);
