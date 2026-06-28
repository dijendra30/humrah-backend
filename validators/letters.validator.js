const { body, validationResult } = require('express-validator');

const validateLetterCreation = [
  body('body')
    .isString().withMessage('Body must be a string')
    .trim()
    .isLength({ min: 10, max: 1500 }).withMessage('Letter body must be between 10 and 1500 characters'),
  body('category')
    .isString().withMessage('Category must be a string')
    .trim()
    .notEmpty().withMessage('Category is required'),
  body('feeling')
    .optional()
    .isString().withMessage('Feeling must be a string')
    .trim(),
  
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    next();
  }
];

const validateLetterReply = [
  body('body')
    .isString().withMessage('Body must be a string')
    .trim()
    .isLength({ min: 5, max: 300 }).withMessage('Reply body must be between 5 and 300 characters'),
  
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    next();
  }
];

const validateLetterReport = [
  body('reason')
    .isString().withMessage('Reason must be a string')
    .trim()
    .notEmpty().withMessage('Reason is required'),
  body('customReason')
    .optional()
    .isString().withMessage('Custom reason must be a string')
    .trim(),
  
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    // Custom logic: if reason is 'Other', customReason is required
    if (req.body.reason === 'Other' && !req.body.customReason) {
      return res.status(400).json({ success: false, message: 'Custom reason is required when reason is "Other"' });
    }
    
    next();
  }
];

module.exports = {
  validateLetterCreation,
  validateLetterReply,
  validateLetterReport
};
