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
async function sendPasswordResetEmail(email, firstName, resetUrl) {
  // ... (the full function is in the backend route file comments above)
}
// --------------------
// EXPORTS (UNCHANGED + CORRECT)
// --------------------
module.exports = {
  sendOTPEmail,
  sendWelcomeEmail,
  sendWarningEmail,   // ✅ new — used by moderation_controller.js
};
