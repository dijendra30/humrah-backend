// models/QuickConnectPreference.js
// -----------------------------------------------------------------------------
// Quick Connect per-user preferences (_id = userId). Today: the Smart Discovery opt-in.
//
// smartDiscovery is OFF unless the user turns it on in the app. fcmToken is the token of the
// phone that turned it on, checked to be registered to this user when saved and again before
// every invitation; invitations go only to that phone, so builds that cannot show them never
// receive them. Withdrawing Quick Connect consent deletes the row.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');

const preferenceSchema = new mongoose.Schema({
  _id:            { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  smartDiscovery: { type: Boolean, required: true, default: false },
  fcmToken:       { type: String, default: null, maxlength: 4096 },
  updatedAt:      { type: Date, required: true, default: Date.now }
}, { versionKey: false, collection: 'quickconnectpreferences' });

preferenceSchema.index({ smartDiscovery: 1 });

module.exports = mongoose.models.QuickConnectPreference || mongoose.model('QuickConnectPreference', preferenceSchema);
