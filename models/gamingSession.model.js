// ─────────────────────────────────────────────────────────────
//  models/gamingSession.model.js   (Mongoose)
// ─────────────────────────────────────────────────────────────
const mongoose = require("mongoose");

const VALID_GAMES = [
  "BGMI","PUBG","PUBG_PC","CALL_OF_DUTY","FREE_FIRE",
  "PHASMOPHOBIA","MINECRAFT","DEAD_BY_DAYLIGHT","AMONG_US","OTHER"
];

const MessageSchema = new mongoose.Schema({
  senderId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  senderUsername: { type: String, required: true },
  text:           { type: String, required: true, maxlength: 500 },
}, { timestamps: { createdAt: "sentAt" } });

const GamingSessionSchema = new mongoose.Schema({
  creatorId:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  creatorUsername:{ type: String, required: true },
  city:           { type: String, required: true },
  gameType:       { type: String, enum: VALID_GAMES, required: true },
  customGameName: { type: String, maxlength: 30, default: null },
  playersNeeded:  { type: Number, min: 2, max: 6, required: true },
  playersJoined:  [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  startTime:      { type: Date, required: true },
  status:         { type: String, enum: ["ACTIVE","STARTED","EXPIRED"], default: "ACTIVE" },
  optionalMessage:{ type: String, maxlength: 120, default: null },
  messages:       [MessageSchema],
  // dismissedBy: users who tapped "Not Interested"
  dismissedBy:    [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
}, { timestamps: true });

// Auto-expire index: MongoDB will mark expired but the route logic checks status
GamingSessionSchema.index({ startTime: 1 });
GamingSessionSchema.index({ city: 1, status: 1 });

module.exports = mongoose.model("GamingSession", GamingSessionSchema);
