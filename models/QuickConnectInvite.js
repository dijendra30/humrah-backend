// models/QuickConnectInvite.js
// -----------------------------------------------------------------------------
// Quick Connect Smart Discovery: one invitation from a searching user to one opted-in
// user (services/quickConnect/discovery.js). An invitation never starts a call by itself:
// accepting it only creates an ordinary match proposal that BOTH people must accept.
//
//   PENDING --recipient accepts--> ACCEPTING --proposal created--> ACCEPTED
//   PENDING --recipient declines--> DECLINED
//   PENDING --expiresAt passed--> EXPIRED
//   PENDING|ACCEPTING --search over / match elsewhere / not possible--> CANCELLED
//
// searchStartedAt ties the invitation to ONE search of the inviter: a later search by the
// same person never revives an old invitation. Every transition is a conditional write on
// the current status. Rows are kept for 2 days (cooldowns and daily limits read them), then
// MongoDB removes them. No profile data is stored: shared interest labels only.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const STATUSES = ['PENDING', 'ACCEPTING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'];

const inviteSchema = new mongoose.Schema({
  inviterId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  recipientId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  searchStartedAt: { type: Date, required: true, immutable: true },
  status:          { type: String, enum: STATUSES, required: true, default: 'PENDING' },
  sharedInterests: { type: [String], default: [] },
  createdAt:       { type: Date, required: true, default: Date.now, immutable: true },
  expiresAt:       { type: Date, required: true },
  respondedAt:     { type: Date, default: null },
  sessionId:       { type: mongoose.Schema.Types.ObjectId, default: null },
  delivery:        { type: String, enum: ['socket', 'push', 'none', null], default: null }
}, { versionKey: false, collection: 'quickconnectinvites' });

// At most one open invitation per recipient at a time (also stops duplicate sends).
inviteSchema.index({ recipientId: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING' } });
inviteSchema.index({ inviterId: 1, status: 1 });
inviteSchema.index({ recipientId: 1, createdAt: -1 });
inviteSchema.index({ status: 1, expiresAt: 1 });
inviteSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 24 * 60 * 60 });

inviteSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.QuickConnectInvite || mongoose.model('QuickConnectInvite', inviteSchema);
