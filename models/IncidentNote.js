// models/IncidentNote.js
// Private incident notes — stored server-side when user chooses "share with Humrah"
// When user keeps it private, it's stored client-side only (SharedPreferences/DataStore)

const mongoose = require('mongoose');

const incidentNoteSchema = new mongoose.Schema({
    // Who wrote it
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    // Person the incident relates to (nullable — may not want to name them)
    relatedUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },

    // Category chosen by user (matches SaveIncidentSheet categories)
    category: {
        type: String,
        enum: [
            'felt_uncomfortable',
            'inappropriate_message',
            'felt_pressured_or_unsafe',
            'something_else',
            ''
        ],
        default: ''
    },

    // Free-text note (user's own words, NOT prompted)
    description: {
        type: String,
        maxlength: 500,
        default: ''
    },

    // Whether user consented to share with Humrah safety team
    sharedWithHumrah: {
        type: Boolean,
        default: false
    },

    // If escalated to a formal report later
    escalatedToReportId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SafetyReport',
        default: null
    },

    // Timestamps
    createdAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

incidentNoteSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('IncidentNote', incidentNoteSchema);
