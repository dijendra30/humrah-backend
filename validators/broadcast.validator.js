// validators/broadcast.validator.js — Input validation for broadcast endpoints (Phase 1)
// Uses express-validator following existing validators/letters.validator.js pattern.

const { body, param, validationResult } = require('express-validator');

// =============================================
// SHARED VALIDATION HANDLER
// =============================================
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

// =============================================
// CREATE / UPDATE BROADCAST
// =============================================
const validateCreateBroadcast = [
  body('title')
    .isString().withMessage('Title must be a string')
    .trim()
    .isLength({ min: 3, max: 120 }).withMessage('Title must be between 3 and 120 characters'),
  body('message')
    .isString().withMessage('Message must be a string')
    .trim()
    .isLength({ min: 10, max: 1000 }).withMessage('Message must be between 10 and 1000 characters'),
  body('type')
    .optional()
    .isIn(['ANNOUNCEMENT', 'UPDATE', 'PROMOTION', 'ALERT', 'REMINDER'])
    .withMessage('Type must be one of: ANNOUNCEMENT, UPDATE, PROMOTION, ALERT, REMINDER'),
  body('audienceType')
    .isString().withMessage('Audience type is required')
    .isIn(['EVERYONE', 'VERIFIED_USERS', 'PREMIUM_USERS', 'STATE', 'CITY', 'AREA', 'CUSTOM'])
    .withMessage('Invalid audience type'),
  body('language')
    .optional()
    .isIn(['en', 'hi', 'both'])
    .withMessage('Language must be one of: en, hi, both'),
  body('targetState')
    .optional()
    .isString().withMessage('Target state must be a string')
    .trim(),
  body('targetCity')
    .optional()
    .isString().withMessage('Target city must be a string')
    .trim(),
  body('targetArea')
    .optional()
    .isString().withMessage('Target area must be a string')
    .trim(),
  body('onlyVerifiedUsers')
    .optional()
    .isBoolean().withMessage('onlyVerifiedUsers must be a boolean'),
  body('onlyPremiumUsers')
    .optional()
    .isBoolean().withMessage('onlyPremiumUsers must be a boolean'),
  body('expiresAt')
    .optional()
    .isISO8601().withMessage('expiresAt must be a valid ISO 8601 date'),

  // Custom validation: audience-specific required fields
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { audienceType, targetState, targetCity, targetArea } = req.body;

    if (audienceType === 'STATE' && !targetState) {
      return res.status(400).json({
        success: false,
        message: 'targetState is required when audienceType is STATE'
      });
    }
    if (audienceType === 'CITY' && !targetCity) {
      return res.status(400).json({
        success: false,
        message: 'targetCity is required when audienceType is CITY'
      });
    }
    if (audienceType === 'AREA' && !targetArea) {
      return res.status(400).json({
        success: false,
        message: 'targetArea is required when audienceType is AREA'
      });
    }

    next();
  }
];

// =============================================
// UPDATE DRAFT (all fields optional)
// =============================================
const validateUpdateDraft = [
  body('title')
    .optional()
    .isString().withMessage('Title must be a string')
    .trim()
    .isLength({ min: 3, max: 120 }).withMessage('Title must be between 3 and 120 characters'),
  body('message')
    .optional()
    .isString().withMessage('Message must be a string')
    .trim()
    .isLength({ min: 10, max: 1000 }).withMessage('Message must be between 10 and 1000 characters'),
  body('type')
    .optional()
    .isIn(['ANNOUNCEMENT', 'UPDATE', 'PROMOTION', 'ALERT', 'REMINDER'])
    .withMessage('Type must be one of: ANNOUNCEMENT, UPDATE, PROMOTION, ALERT, REMINDER'),
  body('audienceType')
    .optional()
    .isIn(['EVERYONE', 'VERIFIED_USERS', 'PREMIUM_USERS', 'STATE', 'CITY', 'AREA', 'CUSTOM'])
    .withMessage('Invalid audience type'),
  body('language')
    .optional()
    .isIn(['en', 'hi', 'both'])
    .withMessage('Language must be one of: en, hi, both'),
  body('targetState').optional().isString().trim(),
  body('targetCity').optional().isString().trim(),
  body('targetArea').optional().isString().trim(),
  body('onlyVerifiedUsers').optional().isBoolean(),
  body('onlyPremiumUsers').optional().isBoolean(),
  body('expiresAt')
    .optional()
    .isISO8601().withMessage('expiresAt must be a valid ISO 8601 date'),
  handleValidationErrors,
];

// =============================================
// AI REPHRASE
// =============================================
const validateAiRephrase = [
  body('title')
    .isString().withMessage('Title is required')
    .trim()
    .notEmpty().withMessage('Title cannot be empty'),
  body('message')
    .isString().withMessage('Message is required')
    .trim()
    .notEmpty().withMessage('Message cannot be empty'),
  body('tone')
    .isString().withMessage('Tone is required')
    .trim()
    .notEmpty().withMessage('Tone cannot be empty'),
  body('language')
    .optional()
    .isIn(['en', 'hi', 'both'])
    .withMessage('Language must be one of: en, hi, both'),
  handleValidationErrors,
];

// =============================================
// BROADCAST ID PARAM
// =============================================
const validateBroadcastId = [
  param('id')
    .isMongoId().withMessage('Invalid broadcast ID'),
  handleValidationErrors,
];

// =============================================
// PREVIEW (same audience fields as create)
// =============================================
const validatePreview = [
  body('audienceType')
    .isString().withMessage('Audience type is required')
    .isIn(['EVERYONE', 'VERIFIED_USERS', 'PREMIUM_USERS', 'STATE', 'CITY', 'AREA', 'CUSTOM'])
    .withMessage('Invalid audience type'),
  body('targetState').optional().isString().trim(),
  body('targetCity').optional().isString().trim(),
  body('targetArea').optional().isString().trim(),
  body('onlyVerifiedUsers').optional().isBoolean(),
  body('onlyPremiumUsers').optional().isBoolean(),
  handleValidationErrors,
];

module.exports = {
  validateCreateBroadcast,
  validateUpdateDraft,
  validateAiRephrase,
  validateBroadcastId,
  validatePreview,
};
