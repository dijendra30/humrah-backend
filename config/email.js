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
// OTP EMAIL HTML (GENZ STYLE ✨)
// --------------------
const getOTPEmailHTML = (otp, firstName) => {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
      padding: 20px; 
      margin: 0;
    }
    .container { 
      max-width: 600px; 
      margin: 0 auto; 
      background: white; 
      padding: 40px; 
      border-radius: 20px; 
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
    }
    .header { 
      text-align: center; 
      margin-bottom: 30px;
    }
    .emoji { 
      font-size: 48px; 
      margin-bottom: 10px;
    }
    h1 { 
      color: #667eea; 
      margin: 10px 0;
      font-size: 28px;
    }
    .message { 
      color: #333; 
      font-size: 16px; 
      line-height: 1.6;
      margin: 20px 0;
    }
    .otp-box { 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
      color: white;
      padding: 25px; 
      text-align: center; 
      font-size: 36px; 
      font-weight: bold; 
      letter-spacing: 8px; 
      border-radius: 15px; 
      margin: 30px 0;
      box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
    }
    .warning { 
      background: #fff3cd; 
      border-left: 4px solid #ffc107; 
      padding: 15px; 
      margin: 20px 0; 
      border-radius: 8px;
      font-size: 14px;
    }
    .footer { 
      text-align: center; 
      color: #666; 
      font-size: 14px; 
      margin-top: 30px; 
      padding-top: 20px; 
      border-top: 1px solid #eee;
    }
    .cta-text {
      font-weight: 600;
      color: #667eea;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="emoji">🔐</div>
      <h1>Your Code is Here!</h1>
    </div>
    
    <p class="message">
      Hey ${firstName || "friend"} 👋<br><br>
      We're vibing with your signup energy! Just need to make sure it's really you before we let you in 🚀
    </p>
    
    <div class="otp-box">${otp}</div>
    
    <div class="warning">
      ⏰ <strong>Quick heads up:</strong> This code expires in 10 minutes, so don't sleep on it!
    </div>
    
    <p class="message">
      Didn't request this? No worries, just ignore this email and you're good to go ✌️
    </p>
    
    <div class="footer">
      <p class="cta-text">Welcome to the Humrah fam! 💜</p>
      <p>© ${new Date().getFullYear()} Humrah. All rights reserved.</p>
    </div>
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
      subject: "Your Verification Code is Here! 🔥",
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
// SEND WELCOME EMAIL (GENZ STYLE ✨)
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
      subject: "You're In! Welcome to Humrah 🎉",
      htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
      padding: 20px; 
      margin: 0;
    }
    .container { 
      max-width: 600px; 
      margin: 0 auto; 
      background: white; 
      padding: 40px; 
      border-radius: 20px; 
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
    }
    .header { 
      text-align: center; 
      margin-bottom: 30px;
    }
    .emoji { 
      font-size: 64px; 
      margin-bottom: 10px;
      animation: bounce 1s infinite;
    }
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
    h1 { 
      color: #667eea; 
      margin: 10px 0;
      font-size: 32px;
    }
    .message { 
      color: #333; 
      font-size: 16px; 
      line-height: 1.8;
      margin: 20px 0;
    }
    .highlight-box {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 25px;
      border-radius: 15px;
      margin: 25px 0;
      text-align: center;
    }
    .feature-list {
      list-style: none;
      padding: 0;
      margin: 20px 0;
    }
    .feature-list li {
      padding: 10px 0;
      font-size: 16px;
    }
    .feature-list li:before {
      content: "✨ ";
      font-size: 18px;
    }
    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 15px 40px;
      border-radius: 25px;
      text-decoration: none;
      font-weight: bold;
      margin: 20px 0;
      box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
    }
    .footer { 
      text-align: center; 
      color: #666; 
      font-size: 14px; 
      margin-top: 30px; 
      padding-top: 20px; 
      border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="emoji">🎉</div>
      <h1>Welcome to the Fam, ${firstName || "friend"}!</h1>
    </div>
    
    <p class="message">
      Yooo! Your email is verified and you're officially part of the Humrah community! 🔥
    </p>
    
    <div class="highlight-box">
      <h2 style="margin: 0 0 10px 0; font-size: 24px;">You're All Set!</h2>
      <p style="margin: 0; font-size: 16px;">Time to explore everything Humrah has to offer 🚀</p>
    </div>
    
    <p class="message">
      Here's what you can do now:
    </p>
    
    <ul class="feature-list">
      <li>Explore all our amazing features</li>
      <li>Connect with the community</li>
      <li>Customize your profile</li>
      <li>Start your journey with us</li>
    </ul>
    
    <div style="text-align: center;">
      <a href="#" class="cta-button">Let's Go! 🚀</a>
    </div>
    
    <p class="message" style="margin-top: 30px;">
      Got questions? We're here for you 24/7. Just hit reply and we'll get back to you ASAP! 💬
    </p>
    
    <div class="footer">
      <p style="font-weight: 600; color: #667eea; font-size: 16px;">Stay awesome! ✌️</p>
      <p>The Humrah Team 💜</p>
      <p>© ${new Date().getFullYear()} Humrah. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
      `,
    };
    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("✅ Welcome email sent to:", email);
  } catch (error) {
    console.error("❌ Failed to send welcome email:", error?.response?.body || error);
  }
}
// --------------------
// SEND WARNING EMAIL  (3-report threshold)
// Called by moderation_controller.js when a user hits 3 reports
// --------------------
async function sendWarningEmail(email, firstName) {
  try {
    console.log("📨 Sending community-guidelines warning to:", email);

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #f4f4f8;
      padding: 20px;
      margin: 0;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background: white;
      padding: 40px;
      border-radius: 20px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    }
    .header { text-align: center; margin-bottom: 30px; }
    .icon { font-size: 52px; margin-bottom: 12px; }
    h1 { color: #333; margin: 10px 0; font-size: 24px; }
    .message {
      color: #444;
      font-size: 15px;
      line-height: 1.8;
      margin: 20px 0;
    }
    .notice-box {
      background: #fff8e1;
      border-left: 4px solid #f5a623;
      padding: 16px 20px;
      border-radius: 8px;
      margin: 24px 0;
      font-size: 14px;
      color: #555;
    }
    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      padding: 13px 32px;
      border-radius: 25px;
      text-decoration: none;
      font-weight: bold;
      margin: 20px 0;
    }
    .footer {
      text-align: center;
      color: #999;
      font-size: 13px;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="icon">🛡️</div>
      <h1>A Note About Community Guidelines</h1>
    </div>

    <p class="message">Hi ${firstName || "there"},</p>

    <p class="message">
      We've received some feedback regarding recent interactions on Humrah involving your account.
    </p>

    <div class="notice-box">
      ℹ️ <strong>Please note:</strong> This does not necessarily mean a rule was broken.
      We want to make sure everyone feels safe and respected on Humrah.
    </div>

    <p class="message">
      We kindly ask you to review our community guidelines and ensure your interactions
      remain respectful and aligned with our values.
    </p>

    <div style="text-align:center">
      <a href="${process.env.COMMUNITY_GUIDELINES_URL || 'https://humrah.com/guidelines'}"
         class="cta-button">
        Review Community Guidelines
      </a>
    </div>

    <p class="message">
      Thanks for helping keep Humrah a safe and welcoming community for everyone. 💜
    </p>

    <div class="footer">
      <p>The Humrah Safety Team</p>
      <p>© ${new Date().getFullYear()} Humrah. All rights reserved.</p>
      <p style="font-size:11px;color:#bbb">
        If you believe this is a mistake, please contact support.
      </p>
    </div>
  </div>
</body>
</html>`;

    const sendSmtpEmail = {
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NAME || "Humrah Safety Team",
      },
      to: [{ email }],
      subject: "Reminder about Humrah community guidelines",
      htmlContent,
    };

    const result = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("✅ Warning email sent. messageId:", result.messageId);
    return { success: true };
  } catch (error) {
    console.error("❌ Failed to send warning email:", error?.response?.body || error);
    throw error;
  }
}

// --------------------
// SEND PASSWORD RESET EMAIL
// Called by routes/passwordReset.js
// --------------------
async function sendPasswordResetEmail(email, firstName, resetUrl) {
  try {
    console.log("📨 Sending password reset email to:", email);

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #0f0c29;
      padding: 20px;
      margin: 0;
    }
    .container {
      max-width: 580px;
      margin: 0 auto;
      background: #1a1a2e;
      padding: 44px 40px;
      border-radius: 24px;
      border: 1px solid rgba(102,126,234,.25);
    }
    .logo {
      font-size: 22px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 32px;
    }
    .logo span { color: #667eea; }
    h1 {
      font-size: 26px;
      font-weight: 800;
      color: #fff;
      margin: 0 0 10px;
      line-height: 1.2;
    }
    .sub {
      color: rgba(255,255,255,.55);
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    .btn-wrap { text-align: center; margin: 32px 0; }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: #fff;
      padding: 16px 40px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      letter-spacing: .01em;
      box-shadow: 0 8px 32px rgba(102,126,234,.45);
    }
    .url-box {
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 10px;
      padding: 14px 16px;
      word-break: break-all;
      font-size: 12px;
      color: rgba(255,255,255,.45);
      margin: 20px 0;
    }
    .notice {
      background: rgba(255,193,7,.08);
      border-left: 3px solid #ffc107;
      padding: 14px 18px;
      border-radius: 0 10px 10px 0;
      font-size: 13px;
      color: rgba(255,255,255,.6);
      margin: 24px 0;
      line-height: 1.6;
    }
    .footer {
      border-top: 1px solid rgba(255,255,255,.08);
      padding-top: 24px;
      margin-top: 32px;
      text-align: center;
      color: rgba(255,255,255,.3);
      font-size: 12px;
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">Hum<span>rah</span> 🌟</div>
    <h1>Reset your password</h1>
    <p class="sub">Hey ${firstName || 'there'} 👋 — we received a request to reset your Humrah password. Click the button below to create a new one.</p>
    <div class="btn-wrap">
      <a href="${resetUrl}" class="btn">Reset my password →</a>
    </div>
    <p style="color:rgba(255,255,255,.4);font-size:13px;text-align:center">Or copy and paste this link in your browser:</p>
    <div class="url-box">${resetUrl}</div>
    <div class="notice">
      ⏰ <strong>This link expires in 15 minutes.</strong><br>
      If you didn't request a password reset, you can safely ignore this email — your account remains secure.
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} Humrah. All rights reserved.</p>
      <p>This is an automated message — please do not reply.</p>
    </div>
  </div>
</body>
</html>`;

    const sendSmtpEmail = {
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NAME || "Humrah",
      },
      to: [{ email }],
      subject: "Reset your Humrah password 🔑",
      htmlContent,
    };

    const result = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("✅ Password reset email sent. messageId:", result.messageId);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error("❌ Failed to send password reset email:", error?.response?.body || error);
    throw error;
  }
}

// --------------------
// EXPORTS
// --------------------
module.exports = {
  sendOTPEmail,
  sendWelcomeEmail,
  sendWarningEmail,
  sendPasswordResetEmail,   // ✅ used by routes/passwordReset.js
};
