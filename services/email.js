/**
 * services/email.js
 * ─────────────────────────────────────────────────────────────
 * Thin wrapper around config/email.js so legacy imports like
 *   require('../services/email')
 * work without errors.
 *
 * payoutCron.js calls: sendEmail({ to, subject, html })
 * config/email.js exports named functions but no generic sendEmail.
 * This file bridges the gap.
 */

'use strict';

const brevo = require('@getbrevo/brevo');

const apiInstance = new brevo.TransactionalEmailsApi();
apiInstance.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY || ''
);

/**
 * Generic send-email used by payoutCron.js
 * @param {{ to: string, subject: string, html: string }} opts
 */
async function sendEmail({ to, subject, html }) {
  if (!to || !subject || !html) {
    throw new Error('[services/email] sendEmail: to, subject, and html are required');
  }

  const payload = {
    sender: {
      email: process.env.BREVO_SENDER_EMAIL || 'noreply@humrah.in',
      name:  process.env.BREVO_SENDER_NAME  || 'Humrah',
    },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  };

  const result = await apiInstance.sendTransacEmail(payload);
  console.log(`[services/email] ✅ Email sent to ${to} — messageId: ${result.messageId}`);
  return { success: true, messageId: result.messageId };
}

module.exports = { sendEmail };
