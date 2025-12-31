const mongoose = require('mongoose');

const SafetyReportSchema = new mongoose.Schema({
    // Reporter (kept confidential)
    reporterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        // Never expose to reported user
        select: false
    },
    
    // Reported user
    reportedUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true // For efficient queries
    },
    
    // Report details
    category: {
        type: String,
        enum: [
            'HARASSMENT',
            'UNSAFE_MEETUP',
            'FAKE_PROFILE',
            'THREATENING',
            'SPAM_SCAM',
            'OTHER'
        ],
        required: true,
        index: true
    },
    
    description: {
        type: String,
        maxlength: 300,
        trim: true
    },
    
    evidenceUrls: [{
        type: String,
        trim: true
    }],
    
    // Contact preferences (confidential)
    contactPreference: {
        inAppChat: { type: Boolean, default: false },
        email: { type: Boolean, default: false },
        phone: { type: Boolean, default: false },
        phoneNumber: {
            type: String,
            trim: true,
            // Only visible to admin/safety team
            select: false
        }
    },
    
    // Report status
    status: {
        type: String,
        enum: ['PENDING', 'UNDER_REVIEW', 'REVIEWED', 'ACTION_TAKEN', 'CLOSED'],
        default: 'PENDING',
        index: true
    },
    
    // Priority (auto-calculated or set by admin)
    priority: {
        type: String,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
        default: 'MEDIUM',
        index: true
    },
    
    // Admin fields
    reviewedAt: { type: Date },
    reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    actionTaken: { type: String },
    adminNotes: { type: String }
    
}, {
    timestamps: true
});

// Indexes for efficient queries
SafetyReportSchema.index({ reportedUserId: 1, createdAt: -1 });
SafetyReportSchema.index({ status: 1, priority: -1, createdAt: -1 });
SafetyReportSchema.index({ category: 1, createdAt: -1 });

// Auto-calculate priority based on:
// - Category severity
// - Number of reports against same user
SafetyReportSchema.pre('save', async function(next) {
    if (this.isNew) {
        // Check how many reports exist for this user
        const reportCount = await this.constructor.countDocuments({
            reportedUserId: this.reportedUserId,
            status: { $in: ['PENDING', 'UNDER_REVIEW'] }
        });
        
        // Set priority based on category and report count
        if (this.category === 'THREATENING') {
            this.priority = 'URGENT';
        } else if (this.category === 'HARASSMENT' || reportCount >= 3) {
            this.priority = 'HIGH';
        } else if (reportCount >= 2) {
            this.priority = 'MEDIUM';
        } else {
            this.priority = 'LOW';
        }
    }
    next();
});

module.exports = mongoose.model('SafetyReport', SafetyReportSchema);
