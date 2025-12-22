const brevo = require('@getbrevo/brevo');

// Initialize Brevo API
const apiInstance = new brevo.TransactionalEmailsApi();
apiInstance.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

// Generate OTP HTML Template
const getOTPEmailHTML = (otp, firstName) => {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; }
    .otp-box { background: #f0f0f0; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; border-radius: 8px; margin: 20px 0; }
    .button { background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Welcome to Humrah! 🎉</h1>
    <p>Hi ${firstName},</p>
    <p>Thank you for registering with Humrah. Please verify your email address using the OTP below:</p>
    
    <div class="otp-box">${otp}</div>
    
    <p><strong>This OTP will expire in 10 minutes.</strong></p>
    
    <p>If you didn't create an account with Humrah, please ignore this email.</p>
    
    <p>Best regards,<br>The Humrah Team</p>
  </div>
</body>
</html>
  `;
};

// Send OTP Email
async function sendOTPEmail(email, otp, firstName) {
  try {
    const sendSmtpEmail = {
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NAME || 'Humrah'
      },
      to: [{ email }],
      subject: `Your Humrah Verification Code: ${otp}`,
      htmlContent: getOTPEmailHTML(otp, firstName)
    };

    const result = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ OTP Email sent successfully to:', email);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('❌ Failed to send OTP email:', error);
    throw error;
  }
}

// Send Welcome Email (after verification)
async function sendWelcomeEmail(email, firstName) {
  try {
    const sendSmtpEmail = {
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NAME || 'Humrah'
      },
      to: [{ email }],
      subject: 'Welcome to Humrah! 🎉',
      htmlContent: `
        <h1>Welcome ${firstName}!</h1>
        <p>Your email has been verified successfully.</p>
        <p>You can now enjoy all features of Humrah.</p>
        <p>Start connecting with amazing people!</p>
      `
    };

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Welcome email sent to:', email);
  } catch (error) {
    console.error('❌ Failed to send welcome email:', error);
  }
}

module.exports = {
  sendOTPEmail,
  sendWelcomeEmail
};