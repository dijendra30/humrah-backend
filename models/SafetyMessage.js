// models/SafetyMessage.js
// Chat messages inside a Safety Ticket conversation.
// Kept in a separate collection (not embedded) to support long conversations.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const safetyMessageSchema = new Schema(
    {
        ticketId: {
            type:     Schema.Types.ObjectId,
            ref:      'SafetyTicket',
            required: true,
            index:    true
        },

        // null  → bot / Humrah Safety Team message
        // ObjectId → user who sent it
        senderId: {
            type:    Schema.Types.ObjectId,
            ref:     'User',
            default: null
        },

        content: {
            type:      String,
            required:  true,
            maxlength: 5000,
            trim:      true
        },

        // true  = Humrah Safety Team (bot or future human agent)
        // false = the reporter
        isFromTeam: {
            type:    Boolean,
            default: true
        },

        // System notifications (ticket opened, resolved, etc.) — shown as pill in UI
        isSystem: {
            type:    Boolean,
            default: false
        }
    },
    {
        // createdAt used as the message timestamp
        timestamps: { createdAt: true, updatedAt: false }
    }
);

safetyMessageSchema.index({ ticketId: 1, createdAt: 1 });

module.exports = mongoose.model('SafetyMessage', safetyMessageSchema);
