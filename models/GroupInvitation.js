// models/GroupInvitation.js — a shareable invitation link to a group conversation.
//
// One collection for every group type (Humrah Room, Sports Plan, Movie Hangout).
// The link carries a random token; only its SHA-256 hash is stored, so a database
// read never yields a working link. Lookups are by `tokenHash` (unique index).
//
// A link stops working when it is revoked, when it expires, when it has been used
// `maxUses` times, or when the group itself can no longer be joined (decided at
// join time by that group's own rules). Expired documents stay for PURGE_AFTER_DAYS
// so an old link still answers "expired" instead of "invalid"; then a TTL index
// removes them.
'use strict';

const mongoose = require('mongoose');

const INVITE_TYPES = Object.freeze(['ROOM', 'SPORTS', 'MOVIE']);
const PURGE_AFTER_DAYS = 30;

const groupInvitationSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true },
  type:      { type: String, enum: INVITE_TYPES, required: true },
  // HumrahRoom / SportsPlan / MovieSession _id. Never returned to clients by the
  // public endpoints.
  targetId:  { type: mongoose.Schema.Types.ObjectId, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  expiresAt: { type: Date, required: true },
  maxUses:   { type: Number, default: null, min: 1 },
  useCount:  { type: Number, default: 0, min: 0 },
  lastUsedAt: { type: Date, default: null },

  revokedAt: { type: Date, default: null },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // TTL: the document is removed this long after it stopped being usable.
  purgeAt:   { type: Date, required: true },
}, { timestamps: true });

groupInvitationSchema.index({ tokenHash: 1 }, { unique: true });
// "my links for this group" (create rate checks, revoke-all on leave in future).
groupInvitationSchema.index({ createdBy: 1, type: 1, targetId: 1, createdAt: -1 });
groupInvitationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

groupInvitationSchema.statics.INVITE_TYPES = INVITE_TYPES;
groupInvitationSchema.statics.PURGE_AFTER_DAYS = PURGE_AFTER_DAYS;

module.exports = mongoose.models.GroupInvitation
  || mongoose.model('GroupInvitation', groupInvitationSchema);
