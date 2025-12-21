// config/email.js - Brevo Email Service
const brevo = require('@getbrevo/brevo');
const crypto = require('crypto');

// Initialize Brevo API client
const apiInstance = new brevo.TransactionalEmailsApi();
apiInstance.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

// Generate verification token
const generateVerificationToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Send verification email
const sendVerificationEmail = async (userEmail, userName, verificationToken) => {
  const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

  const sendSmtpEmail = new brevo.SendSmtpEmail();

  sendSmtpEmail.subject = "Verify Your Humrah Account";
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          font-family: 'Arial', sans-serif;
          background-color: #f4f4f4;
          margin: 0;
          padding: 0;
        }
        .container {
          max-width: 600px;
          margin: 40px auto;
          background-color: #ffffff;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          padding: 40px 20px;
          text-align: center;
        }
        .header h1 {
          color: #ffffff;
          margin: 0;
          font-size: 32px;
          font-weight: bold;
        }
        .content {
          padding: 40px 30px;
          color: #333333;
        }
        .content h2 {
          color: #667eea;
          margin-bottom: 20px;
        }
        .content p {
          line-height: 1.8;
          font-size: 16px;
          color: #555555;
        }
        .button {
          display: inline-block;
          padding: 16px 40px;
          margin: 30px 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #ffffff;
          text-decoration: none;
          border-radius: 50px;
          font-weight: bold;
          font-size: 16px;
          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
          transition: all 0.3s ease;
        }
        .button:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
        }
        .footer {
          background-color: #f8f9fa;
          padding: 20px;
          text-align: center;
          color: #888888;
          font-size: 14px;
        }
        .divider {
          height: 2px;
          background: linear-gradient(90deg, transparent, #667eea, transparent);
          margin: 30px 0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🎉 Welcome to Humrah!</h1>
        </div>
        <div class="content">
          <h2>Hi ${userName}! 👋</h2>
          <p>We're excited to have you join the Humrah community! You're just one step away from connecting with amazing companions.</p>
          
          <div class="divider"></div>
          
          <p><strong>To complete your registration, please verify your email address:</strong></p>
          
          <center>
            <a href="${verificationLink}" class="button">
              ✓ Verify My Email
            </a>
          </center>
          
          <p style="margin-top: 30px; font-size: 14px; color: #888888;">
            If the button doesn't work, copy and paste this link into your browser:<br>
            <a href="${verificationLink}" style="color: #667eea; word-break: break-all;">
              ${verificationLink}
            </a>
          </p>
          
          <div class="divider"></div>
          
          <p style="font-size: 14px; color: #888888;">
            <strong>Note:</strong> This verification link will expire in 24 hours for security reasons.
          </p>
        </div>
        <div class="footer">
          <p>Made with ❤️ by Humrah Team</p>
          <p style="margin: 10px 0;">
            If you didn't create an account, please ignore this email.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  sendSmtpEmail.sender = {
    name: process.env.BREVO_SENDER_NAME,
    email: process.env.BREVO_SENDER_EMAIL
  };

  sendSmtpEmail.to = [{ email: userEmail, name: userName }];

  try {
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Verification email sent successfully:', data);
    return { success: true, messageId: data.messageId };
  } catch (error) {
    console.error('❌ Error sending verification email:', error);
    throw error;
  }
};

// Send welcome email after verification
const sendWelcomeEmail = async (userEmail, userName) => {
  const sendSmtpEmail = new brevo.SendSmtpEmail();

  sendSmtpEmail.subject = "🎉 Welcome to Humrah - Let's Get Started!";
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          font-family: 'Arial', sans-serif;
          background-color: #f4f4f4;
          margin: 0;
          padding: 0;
        }
        .container {
          max-width: 600px;
          margin: 40px auto;
          background-color: #ffffff;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .header {
          background: linear-gradient(135deg, #00F5FF 0%, #FF6B9D 50%, #FFD93D 100%);
          padding: 40px 20px;
          text-align: center;
        }
        .header h1 {
          color: #ffffff;
          margin: 0;
          font-size: 32px;
          font-weight: bold;
          text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        }
        .content {
          padding: 40px 30px;
          color: #333333;
        }
        .feature {
          background: #f8f9fa;
          padding: 20px;
          border-radius: 8px;
          margin: 15px 0;
          border-left: 4px solid #667eea;
        }
        .feature h3 {
          color: #667eea;
          margin: 0 0 10px 0;
        }
        .feature p {
          margin: 0;
          color: #555555;
        }
        .button {
          display: inline-block;
          padding: 16px 40px;
          margin: 30px 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #ffffff;
          text-decoration: none;
          border-radius: 50px;
          font-weight: bold;
          font-size: 16px;
          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        .footer {
          background-color: #f8f9fa;
          padding: 20px;
          text-align: center;
          color: #888888;
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>✨ You're All Set! ✨</h1>
        </div>
        <div class="content">
          <h2>Welcome, ${userName}! 🎊</h2>
          <p>Your email has been verified successfully! You're now part of the Humrah family.</p>
          
          <h3 style="color: #667eea; margin-top: 30px;">What You Can Do Now:</h3>
          
          <div class="feature">
            <h3>👥 Find Companions</h3>
            <p>Discover people who share your interests and connect with them!</p>
          </div>
          
          <div class="feature">
            <h3>🎉 Join Events</h3>
            <p>Participate in exciting events and activities in your area.</p>
          </div>
          
          <div class="feature">
            <h3>💰 Earn Money</h3>
            <p>Become a companion and earn by helping others!</p>
          </div>
          
          <center>
            <a href="${process.env.FRONTEND_URL}" class="button">
              🚀 Start Exploring
            </a>
          </center>
        </div>
        <div class="footer">
          <p>Need help? Reply to this email anytime!</p>
          <p style="margin-top: 10px;">Made with ❤️ by Humrah Team</p>
        </div>
      </div>
    </body>
    </html>
  `;

  sendSmtpEmail.sender = {
    name: process.env.BREVO_SENDER_NAME,
    email: process.env.BREVO_SENDER_EMAIL
  };

  sendSmtpEmail.to = [{ email: userEmail, name: userName }];

  try {
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Welcome email sent successfully');
    return { success: true };
  } catch (error) {
    console.error('❌ Error sending welcome email:', error);
    throw error;
  }
};

// Send profile verification notification email
const sendProfileVerificationEmail = async (userEmail, userName, isApproved) => {
  const sendSmtpEmail = new brevo.SendSmtpEmail();

  if (isApproved) {
    sendSmtpEmail.subject = "✅ Your Profile Has Been Verified!";
    sendSmtpEmail.htmlContent = `
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px;">
          <h1 style="color: #00FF88; text-align: center;">✅ Verified!</h1>
          <p>Hi ${userName},</p>
          <p>Great news! Your profile photo has been manually verified by our team.</p>
          <p>You now have a <strong style="color: #00FF88;">verified badge ✓</strong> on your profile!</p>
          <p>This increases your credibility and helps you connect with more people.</p>
          <center>
            <a href="${process.env.FRONTEND_URL}" style="display: inline-block; padding: 15px 30px; background: #00FF88; color: white; text-decoration: none; border-radius: 50px; margin-top: 20px;">
              View My Profile
            </a>
          </center>
        </div>
      </body>
      </html>
    `;
  } else {
    sendSmtpEmail.subject = "Profile Verification - Additional Information Needed";
    sendSmtpEmail.htmlContent = `
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px;">
          <h1 style="color: #FF6B9D;">Profile Verification Update</h1>
          <p>Hi ${userName},</p>
          <p>We've reviewed your profile photo, and unfortunately we need you to upload a clearer image.</p>
          <p><strong>Please ensure:</strong></p>
          <ul>
            <li>Your face is clearly visible</li>
            <li>Good lighting</li>
            <li>No filters or heavy editing</li>
            <li>Recent photo</li>
          </ul>
          <center>
            <a href="${process.env.FRONTEND_URL}/profile" style="display: inline-block; padding: 15px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 50px; margin-top: 20px;">
              Upload New Photo
            </a>
          </center>
        </div>
      </body>
      </html>
    `;
  }

  sendSmtpEmail.sender = {
    name: process.env.BREVO_SENDER_NAME,
    email: process.env.BREVO_SENDER_EMAIL
  };

  sendSmtpEmail.to = [{ email: userEmail, name: userName }];

  try {
    await apiInstance.sendTransacEmail(sendSmtpEmail);
    return { success: true };
  } catch (error) {
    console.error('Error sending profile verification email:', error);
    throw error;
  }
};

module.exports = {
  generateVerificationToken,
  sendVerificationEmail,
  sendWelcomeEmail,
  sendProfileVerificationEmail
};
