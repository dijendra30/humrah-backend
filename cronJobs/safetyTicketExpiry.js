// cronJobs/safetyTicketExpiry.js
'use strict';

const SafetyTicket  = require('../models/SafetyTicket');
const SafetyMessage = require('../models/SafetyMessage');

const RISK_EXPIRY_HOURS = {
    LOW:      48,
    MEDIUM:   7 * 24,
    HIGH:     14 * 24,
    CRITICAL: null // Never auto-expire
};

async function checkExpiry() {
    try {
        const activeTickets = await SafetyTicket.find({
            status: { $in: ['OPEN', 'UNDER_REVIEW', 'ASSISTANCE_REQUESTED'] }
        });

        const now = new Date();

        for (const ticket of activeTickets) {
            const expiryHours = RISK_EXPIRY_HOURS[ticket.riskLevel || 'LOW'];
            if (expiryHours === null) continue;

            const expiryTime = new Date(ticket.createdAt.getTime() + expiryHours * 60 * 60 * 1000);
            const timeUntilExpiry = expiryTime.getTime() - now.getTime();
            const hoursUntilExpiry = timeUntilExpiry / (60 * 60 * 1000);

            if (hoursUntilExpiry <= 0) {
                // Auto Close
                ticket.status = 'AUTO_RESOLVED';
                await ticket.save();

                await SafetyMessage.create({
                    ticketId:   ticket._id,
                    content:    'This safety report was automatically closed due to inactivity.',
                    isFromTeam: true,
                    isSystem:   true
                });

                console.log(`[SAFETY_EXPIRY] Auto-resolved ticketId=${ticket.ticketId}`);
            } 
            else if (hoursUntilExpiry <= 24 && !ticket.expiryWarningSent) {
                // Send Follow-Up
                ticket.expiryWarningSent = true;
                await ticket.save();

                await SafetyMessage.create({
                    ticketId:   ticket._id,
                    content:    '🛡 Safety Follow-Up\n\nWe have not received any further activity regarding this report. This ticket will automatically close in 24 hours unless you need additional assistance.',
                    isFromTeam: true,
                    isSystem:   true
                });

                console.log(`[SAFETY_EXPIRY] Sent 24h warning for ticketId=${ticket.ticketId}`);
            }
        }
    } catch (err) {
        console.error('[SAFETY_EXPIRY] Error during checkExpiry:', err);
    }
}

module.exports = { checkExpiry };
