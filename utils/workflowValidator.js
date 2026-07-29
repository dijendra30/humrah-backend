'use strict';

/**
 * Validates whether a requested action is allowed for a given reply preference.
 * This is the centralized workflow rule engine for the Founder Communication System.
 * 
 * @param {string} replyPreference - The preference stored in MongoDB ('NO_REPLY', 'EMAIL', 'FOLLOW_UP')
 * @param {string} requestedAction - The action being attempted ('REPLY_BY_EMAIL', 'START_DISCUSSION', 'MARK_READ', 'ARCHIVE', 'CLOSE')
 * @returns {object} { isValid: boolean, message: string }
 */
exports.validateWorkflowAction = (replyPreference, requestedAction) => {
  // Global actions allowed for all workflows
  if (['MARK_READ', 'ARCHIVE', 'CLOSE'].includes(requestedAction)) {
    return { isValid: true };
  }

  switch (replyPreference) {
    case 'NO_REPLY':
      return { 
        isValid: false, 
        message: `Workflow conflict: The action '${requestedAction}' is not permitted because the user requested no reply.` 
      };

    case 'EMAIL':
      if (requestedAction === 'REPLY_BY_EMAIL') {
        return { isValid: true };
      }
      return { 
        isValid: false, 
        message: `Workflow conflict: The action '${requestedAction}' is not permitted. This message is restricted to email replies.` 
      };

    case 'FOLLOW_UP':
      if (requestedAction === 'START_DISCUSSION') {
        return { isValid: true };
      }
      return { 
        isValid: false, 
        message: `Workflow conflict: The action '${requestedAction}' is not permitted. This message is restricted to follow-up discussions.` 
      };

    default:
      return { 
        isValid: false, 
        message: `Invalid reply preference: '${replyPreference}'. Cannot validate workflow.` 
      };
  }
};
