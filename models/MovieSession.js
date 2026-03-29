// models/MovieSession.js
const mongoose = require('mongoose');

const movieSessionSchema = new mongoose.Schema({
  movieId:        { type: String, required: true },
  title:          { type: String, required: true },
  posterPath:     { type: String, default: null },
  overview:       { type: String, default: '' },
  rating:         { type: Number, default: 0 },

  theatreName:    { type: String, required: true },
  theatreAddress: { type: String, required: true },
  theatrePlaceId: { type: String, default: null },

  // GeoJSON Point — coordinates stored as [lng, lat] (MongoDB standard)
  theatreLocation: {
    type:        { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }
  },

  date:         { type: String, required: true }, // "YYYY-MM-DD"
  time:         { type: String, required: true }, // "HH:mm"
  showDateTime: { type: Date,   required: true },

  expiresAt:     { type: Date, required: true }, // showDateTime + 5 min  (card disappears)
  chatExpiresAt: { type: Date, required: true }, // showDateTime + 3 hrs  (chat stays)

  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  maxParticipants: { type: Number, default: 5, min: 2, max: 5 },
  isUrgent:        { type: Boolean, default: false },
  status:          { type: String, enum: ['active', 'expired'], default: 'active' },

  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'MovieChat', default: null }
}, { timestamps: true });

movieSessionSchema.index({ theatreLocation: '2dsphere' });
movieSessionSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('MovieSession', movieSessionSchema);
