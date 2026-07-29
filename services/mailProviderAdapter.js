'use strict';

const nodemailer = require('nodemailer');

/**
 * Mail Provider Adapter
 * Abstracts the email provider logic so the workflow doesn't depend on a specific transport.
 * Initial provider: Zoho Mail.
 */
exports.sendMail = async (to, subject, text) => {
  const transporter = nodemailer.createTransport({
    host: process.env.ZOHO_SMTP_HOST || 'smtp.zoho.in',
    port: process.env.ZOHO_SMTP_PORT || 465,
    secure: true,
    auth: {
      user: process.env.ZOHO_EMAIL || 'founder@humrah.in',
      pass: process.env.ZOHO_PASSWORD || 'dummy_password'
    }
  });

  const mailOptions = {
    from: process.env.ZOHO_EMAIL || 'founder@humrah.in',
    to,
    subject,
    text
  };

  return transporter.sendMail(mailOptions);
};
