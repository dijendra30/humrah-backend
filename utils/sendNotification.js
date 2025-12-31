// utils/sendNotification.js
const sendAdminNotification = async (report) => {
    // Send email to safety team
    await sendEmail({
        to: 'safety@humrah.in',
        subject: `New ${report.priority} Priority Report`,
        template: 'safety-report',
        data: {
            reportId: report._id,
            category: report.category,
            priority: report.priority,
            reportedUser: report.reportedUserId
        }
    });
};

// Call after report creation
SafetyReportSchema.post('save', async function(doc) {
    if (doc.isNew && doc.priority === 'URGENT') {
        await sendAdminNotification(doc);
    }
});