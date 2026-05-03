// models/OrphanageClick.js
//
// ONE document per user — guaranteed by the unique index on userId.
// tapCount tracks how many times that user has tapped the card.
// The route uses findOneAndUpdate + upsert so the first tap creates
// the record and every subsequent tap just increments tapCount.

const mongoose = require('mongoose');

const orphanageClickSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      unique:   true   // ← enforces one doc per user at the DB level
    },
    name:     { type: String, default: '' },  // display name at time of FIRST tap
    email:    { type: String, default: '' },  // email at time of FIRST tap
    action:   { type: String, default: 'orphanage_click' },
    source:   { type: String, default: 'home_screen' },
    tapCount: { type: Number, default: 1, min: 1 }, // total taps by this user
    firstTapAt: { type: Date, default: Date.now },   // when they first tapped
    lastTapAt:  { type: Date, default: Date.now }    // most recent tap
  },
  { timestamps: true }
);

module.exports = mongoose.model('OrphanageClick', orphanageClickSchema);
