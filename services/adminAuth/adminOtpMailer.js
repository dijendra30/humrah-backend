// services/adminAuth/adminOtpMailer.js — delivers Admin Dashboard codes.
// Uses the email providers Humrah already runs (Resend, which the old admin OTP used, or Brevo).
// The recipient is ALWAYS config.otpDestination; callers cannot pass one in.
// The code is never logged.
'use strict';

const config = require('../../config/adminAuthConfig');

const SUBJECT = 'Humrah Admin Login Verification Code';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render({ otp, adminEmail, requestedAt, ttlMinutes }) {
  const when = new Date(requestedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
  const text = [
    'Hello,',
    '',
    'A login verification request was initiated for the Humrah Admin Dashboard.',
    '',
    `Admin account: ${adminEmail}`,
    `Requested: ${when}`,
    '',
    'Your verification code is:',
    '',
    otp,
    '',
    `This code expires in ${ttlMinutes} minutes.`,
    '',
    'Do not share this code with anyone.',
    '',
    'If you did not initiate this login request, you can ignore this email.',
    '',
    'Humrah Administration Team',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px">
<p style="margin:0 0 16px">Hello,</p>
<p style="margin:0 0 16px">A login verification request was initiated for the Humrah Admin Dashboard.</p>
<p style="margin:0 0 4px;font-size:13px;color:#52606d">Admin account: <strong>${esc(adminEmail)}</strong></p>
<p style="margin:0 0 20px;font-size:13px;color:#52606d">Requested: ${esc(when)}</p>
<p style="margin:0 0 8px">Your verification code is:</p>
<p style="margin:0 0 20px;font-size:32px;font-weight:bold;letter-spacing:8px;font-family:Consolas,Menlo,monospace">${esc(otp)}</p>
<p style="margin:0 0 12px">This code expires in ${ttlMinutes} minutes.</p>
<p style="margin:0 0 12px"><strong>Do not share this code with anyone.</strong></p>
<p style="margin:0 0 20px;color:#52606d">If you did not initiate this login request, you can ignore this email.</p>
<p style="margin:0">Humrah Administration Team</p>
</div></body></html>`;
  return { text, html };
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('EMAIL_TIMEOUT')), ms); })])
    .finally(() => clearTimeout(t));
}

async function sendViaResend({ to, subject, html, text }) {
  const { Resend } = require('resend'); // lazy: the API key is read at send time
  const client = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await client.emails.send({ from: config.get().emailFrom, to, subject, html, text });
  if (error) throw new Error(`RESEND_${error.name || 'ERROR'}`);
  return data && data.id ? String(data.id) : null;
}

async function sendViaBrevo({ to, subject, html }) {
  const { sendEmail } = require('../email');
  const r = await sendEmail({ to, subject, html });
  return r && r.messageId ? String(r.messageId) : null;
}

/**
 * @returns {Promise<{ ok:true, provider, messageId } | { ok:false, provider, reason }>}
 */
async function sendAdminOtp({ otp, adminEmail, requestedAt = new Date() }) {
  const cfg = config.get();
  const to = cfg.otpDestination; // fixed by the server
  const provider = cfg.emailProvider;
  const body = render({ otp, adminEmail, requestedAt, ttlMinutes: Math.round(cfg.otpTtlMs / 60000) });
  const msg = { to, subject: SUBJECT, ...body };
  try {
    let messageId;
    if (provider === 'resend') {
      if (!process.env.RESEND_API_KEY) return { ok: false, provider, reason: 'NOT_CONFIGURED' };
      messageId = await withTimeout(sendViaResend(msg), cfg.emailTimeoutMs);
    } else if (provider === 'brevo') {
      if (!process.env.BREVO_API_KEY) return { ok: false, provider, reason: 'NOT_CONFIGURED' };
      messageId = await withTimeout(sendViaBrevo(msg), cfg.emailTimeoutMs);
    } else {
      return { ok: false, provider, reason: 'NOT_CONFIGURED' };
    }
    return { ok: true, provider, messageId };
  } catch (err) {
    // Message names only — provider errors can echo the request, which contains the code.
    console.error(`[admin-otp-mail] ${provider} delivery failed:`, err && err.name, err && /^[A-Z_]+$/.test(err.message || '') ? err.message : '');
    return { ok: false, provider, reason: 'SEND_FAILED' };
  }
}

module.exports = { sendAdminOtp, render, SUBJECT };
