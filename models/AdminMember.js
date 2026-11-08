// models/AdminMember.js — limited-access dashboard members added by an owner (Admin Logs page).
// The record is kept after removal (status REMOVED) so a removed member is still recognised as
// "managed" and gets no admin access through any path, including the phone app.
'use strict';

const mongoose = require('mongoose');

const actor = { userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, email: String };

const schema = new mongoose.Schema({
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sections:  { type: [String], default: [] },
  note:      { type: String, default: '', maxlength: 60 },
  status:    { type: String, enum: ['ACTIVE', 'REMOVED'], default: 'ACTIVE', index: true },
  createdStaffAccount: { type: Boolean, default: false }, // true when the User was created for this member
  addedBy:   actor,
  updatedBy: actor,
  removedBy: actor,
  removedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'adminmembers' });

module.exports = mongoose.models.AdminMember || mongoose.model('AdminMember', schema);
