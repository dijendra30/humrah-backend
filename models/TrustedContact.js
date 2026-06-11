// models/TrustedContact.js
// One trusted contact per user (MVP — can expand to multiple in v2)

const mongoose = require('mongoose');

const trustedContactSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true
    },

    name: {
        type: String,
        required: true,
        maxlength: 100,
        trim: true
    },

    // Stored as plain string — user controls phone, never auto-messaged by server
    phone: {
        type: String,
        required: true,
        maxlength: 20,
        trim: true
    },

    // Relationship label chosen by the user (Friend, Parent, etc.)
    relationship: {
        type: String,
        maxlength: 50,
        trim: true,
        default: ''
    },

    isVerified: {
        type: Boolean,
        default: false
    },

    lastAlertSentAt: {
        type: Date,
        default: null
    },

    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

module.exports = mongoose.model('TrustedContact', trustedContactSchema);
