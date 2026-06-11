// services/telegramService.js
// Two-bot Telegram integration for the Humrah Safety System.
//
// Bot 1 — Humrah Safety Reports   (TELEGRAM_SAFETY_BOT_TOKEN + TELEGRAM_SAFETY_CHAT_ID)
//   Sends reports for ALL risk levels (volume-appropriate detail per level).
//
// Bot 2 — Humrah Emergency Assistance (TELEGRAM_EMERGENCY_BOT_TOKEN + TELEGRAM_EMERGENCY_CHAT_ID)
//   Activated only when user presses "Need Assistance" or shares live location.
//
// All sends are fire-and-forget — never throw, only log.

'use strict';

const axios = require('axios');

const TG_API = 'https://api.telegram.org/bot';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function sendMessage(token, chatId, text, parseMode = 'HTML') {
    if (!token || !chatId) {
        console.warn('[Telegram] Bot token or chat ID missing — skipping notification.');
        return null;
    }
    try {
        const res = await axios.post(
            `${TG_API}${token}/sendMessage`,
            { chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true },
            { timeout: 8_000 }
        );
        return res.data?.result?.message_id ?? null;
    } catch (err) {
        console.error('[Telegram] sendMessage failed:', err.message);
        return null;
    }
}

function esc(str = '') {
    // Escape HTML special chars for Telegram HTML mode
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatTs(date) {
    return date ? new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A';
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot 1 — Safety Reports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify the Safety Reports channel based on risk level.
 * LOW    → minimal (just IDs)
 * MEDIUM → user names + IDs
 * HIGH   → full report
 * CRITICAL → full report + 🚨 alert header
 *
 * @returns {Promise<string|null>} Telegram message ID (for future edits)
 */
async function notifySafetyChannel(ticket) {
    const token  = process.env.TELEGRAM_SAFETY_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_SAFETY_CHAT_ID;
    const { riskLevel } = ticket;
    let text;

    if (riskLevel === 'LOW') {
        text = [
            `🔵 <b>Safety concern reported.</b>`,
            ``,
            `User ID: <code>${esc(ticket.reporterId)}</code>`,
            `Risk: <b>LOW</b>`
        ].join('\n');
    } else if (riskLevel === 'MEDIUM') {
        text = [
            `🟡 <b>Safety concern reported.</b>`,
            ``,
            `User: <b>${esc(ticket.reporterName)}</b>`,
            `User ID: <code>${esc(ticket.reporterId)}</code>`,
            `Reported User: <b>${esc(ticket.reportedUserName || 'Unknown')}</b>`,
            `Reported User ID: <code>${esc(ticket.reportedUserId || 'N/A')}</code>`,
            `Risk: <b>MEDIUM</b>`
        ].join('\n');
    } else if (riskLevel === 'HIGH') {
        text = buildFullReport(ticket, false);
    } else if (riskLevel === 'CRITICAL') {
        text = buildFullReport(ticket, true);
    }

    return sendMessage(token, chatId, text);
}

function buildFullReport(ticket, isCritical) {
    const lines = [];
    if (isCritical) lines.push(`🚨 <b>⚠ CRITICAL SAFETY ALERT ⚠</b>`, ``);
    else            lines.push(`🔴 <b>SAFETY REPORT — HIGH RISK</b>`, ``);

    lines.push(
        `🎫 Ticket: <code>${esc(ticket.ticketId)}</code>`,
        ``,
        `👤 Reporter: <b>${esc(ticket.reporterName)}</b>`,
        `   ID: <code>${esc(ticket.reporterId)}</code>`,
        ``,
        `🎯 Reported User: <b>${esc(ticket.reportedUserName || 'Unknown')}</b>`,
        `   ID: <code>${esc(ticket.reportedUserId || 'N/A')}</code>`,
        ``,
        `📋 Concern Type: <b>${esc(ticket.concernType?.replace(/_/g, ' '))}</b>`,
        ``,
        `📝 User Note:`,
        `<i>${esc(ticket.note || 'No note provided')}</i>`,
        ``,
        `🤖 Gemini Summary:`,
        `<i>${esc(ticket.geminiSummary || 'Pending analysis')}</i>`,
        ``,
        `🏷 Detected Category: <b>${esc(ticket.detectedCategory || 'N/A')}</b>`,
        `📊 Risk Score: <b>${ticket.riskScore ?? 0}/100</b>`,
        ``,
        `🕐 Time: ${esc(formatTs(ticket.createdAt))}`
    );

    if (isCritical) lines.push(``, `⚠️ <b>IMMEDIATE ATTENTION REQUIRED</b>`);

    return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot 2 — Emergency Assistance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fired when user presses "Need Assistance" — Step 10.
 */
async function notifyEmergencyChannel(ticket) {
    const token  = process.env.TELEGRAM_EMERGENCY_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_EMERGENCY_CHAT_ID;

    const text = [
        `🚨 <b>USER REQUESTED HUMAN ASSISTANCE</b>`,
        ``,
        `Ticket ID: <code>${esc(ticket.ticketId)}</code>`,
        ``,
        `User: <b>${esc(ticket.reporterName)}</b>`,
        `User ID: <code>${esc(ticket.reporterId)}</code>`,
        ``,
        `Risk: <b>${esc(ticket.riskLevel)}</b>`,
        ``,
        `Time: ${esc(formatTs(new Date()))}`,
        ``,
        `Status: <b>WAITING_FOR_AGENT</b>`
    ].join('\n');

    return sendMessage(token, chatId, text);
}

/**
 * Fired when user shares location — Step 12.
 */
async function notifyLocationShared(ticket, latitude, longitude) {
    const token  = process.env.TELEGRAM_EMERGENCY_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_EMERGENCY_CHAT_ID;

    const mapsLink = `https://maps.google.com/?q=${latitude},${longitude}`;

    const text = [
        `📍 <b>USER SHARED LOCATION</b>`,
        ``,
        `Ticket: <code>${esc(ticket.ticketId)}</code>`,
        ``,
        `User: <b>${esc(ticket.reporterName)}</b>`,
        `User ID: <code>${esc(ticket.reporterId)}</code>`,
        ``,
        `Coordinates:`,
        `  Latitude:  <code>${latitude}</code>`,
        `  Longitude: <code>${longitude}</code>`,
        ``,
        `📌 Google Maps: ${mapsLink}`
    ].join('\n');

    return sendMessage(token, chatId, text);
}

/**
 * Fired when user resolves ticket via "I Am Safe" — Step 8 update.
 */
async function notifyTicketResolved(ticketId, riskLevel) {
    const token  = process.env.TELEGRAM_SAFETY_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_SAFETY_CHAT_ID;

    const text = [
        `✅ <b>Ticket Resolved by User</b>`,
        ``,
        `Ticket: <code>${esc(ticketId)}</code>`,
        `Risk was: <b>${esc(riskLevel)}</b>`,
        ``,
        `User confirmed they are safe.`
    ].join('\n');

    return sendMessage(token, chatId, text);
}

module.exports = {
    notifySafetyChannel,
    notifyEmergencyChannel,
    notifyLocationShared,
    notifyTicketResolved
};
