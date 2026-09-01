const mongoose = require('mongoose');

const meetupSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'HumrahRoom', required: true },
  proposedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  locationName: { type: String, required: true },
  latitude: { type: Number },
  longitude: { type: Number },
  time: { type: Date, required: true },
  status: { type: String, enum: ['PROPOSED', 'CONFIRMED', 'CANCELLED'], default: 'PROPOSED' },
  votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

module.exports = mongoose.model('Meetup', meetupSchema);
