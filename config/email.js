const brevo = require("@getbrevo/brevo");

// --------------------
// INIT BREVO API (UNCHANGED, JUST SAFER)
// --------------------
const apiInstance = new brevo.TransactionalEmailsApi();

// IMPORTANT: ensure API key exists
if (!process.env.BREVO_API_KEY) {
  console.error("❌ BREVO_API_KEY is missing in env");
}

apiInstance.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

// --------------------
// OTP EMAIL HTML (UNCHANGED)
// --------------------
const getOTPEmailHTML = (otp, firstName) => {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; }
    .otp-box { background: #f0f0f0; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; border-radius: 8px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Welcome to Humrah! 🎉</h1>
    <p>Hi ${firstName || "there"},</p>
    <p>Please verify your email using the OTP below:</p>
    <div class="otp-box">${otp}</div>
    <p><strong>This OTP will expire in 10 minutes.</strong></p>
    <p>If you didn’t request this, ignore this email.</p>
    <p>— Humrah Team</p>
  </div>
</body>
</html>
  `;
};

// --------------------
// SEND OTP EMAIL (FIXED, NOT REPLACED)
// --------------------
async function sendOTPEmail(email, otp, firstName) {
  try {
    console.log("📨 Sending OTP email to:", email);

    const sendSmtpEmail = {
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NAME || "Humrah",
      },
      to: [{ email }],
      subject: "Your Humrah Verification Code",
      htmlContent: getOTPEmailHTML(otp, firstName),
    };

    const result = await apiInstance.sendTransacEmail(sendSmtpEmail);

    console.log("✅ OTP Email sent. Brevo messageId:", result.messageId);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error("❌ Failed to send OTP email:", error?.response?.body || error);
    throw error;
  }
}

// --------------------
// SEND WELCOME EMAIL (UNCHANGED, JUST LOG IMPROVED)
// --------------------
async function sendWelcomeEmail(email, firstName) {
  try {
    console.log("📨 Sending welcome email to:", email);

    const sendSmtpEmail = {
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NAME || "Humrah",
      },
      to: [{ email }],
      subject: "Welcome to Humrah! 🎉",
      htmlContent: `
        <h1>Welcome ${firstName || "there"}!</h1>
        <p>Your email has been verified successfully.</p>
        <p>You can now enjoy all features of Humrah.</p>
      `,
    };

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("✅ Welcome email sent to:", email);
  } catch (error) {
    console.error("❌ Failed to send welcome email:", error?.response?.body || error);
  }
}

// --------------------
// EXPORTS (UNCHANGED + CORRECT)
// --------------------
module.exports = {
  sendOTPEmail,
  sendWelcomeEmail,
};
