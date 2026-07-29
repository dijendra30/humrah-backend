'use strict';

const FounderMessage = require('../models/FounderMessage');
const { sendMail } = require('./mailProviderAdapter');
const { emitFounderEvent } = require('./founderNotificationService');

/**
 * Handles the email workflow for a founder message.
 * @param {string} messageId - The ID of the FounderMessage
 * @param {string} replyText - The administrator's reply
 */
exports.sendFounderEmailReply = async (messageId, replyText) => {
  try {
    const message = await FounderMessage.findById(messageId).populate('user', 'email');
    if (!message) {
      throw new Error('Message not found');
    }

    if (message.replyPreference !== 'EMAIL') {
      throw new Error('Message is not eligible for email workflow');
    }

    if (message.emailStatus === 'SENDING' || message.emailStatus === 'SENT') {
      throw new Error('Email is already sending or sent');
    }

    // Persist SENDING state and preserve the reply draft
    message.emailStatus = 'SENDING';
    message.founderReply = replyText;
    await message.save();

    // Configure email content
    const recipientEmail = message.user.email;
    const subject = 'Humrah Founder Response';
    
    // Abstracted transport
    await sendMail(recipientEmail, subject, replyText);

    // Persist SENT state and update workflow status
    message.emailStatus = 'SENT';
    message.status = 'REPLIED';
    message.replyTimestamp = new Date();
    await message.save();

    // Trigger Notification
    await emitFounderEvent(message.user._id.toString(), message, 'EMAIL_SENT');

    return { success: true, message: 'Email sent successfully' };

  } catch (error) {
    console.error('[FounderEmailService] Failed to send email:', error);

    // If it's a provider failure or validation failure, persist FAILED state but preserve the draft
    try {
      const message = await FounderMessage.findById(messageId);
      if (message) {
        message.emailStatus = 'FAILED';
        // Draft (founderReply) remains intact from the earlier save
        await message.save();
      }
    } catch (saveError) {
      console.error('[FounderEmailService] Failed to persist FAILED status:', saveError);
    }

    throw error;
  }
};
