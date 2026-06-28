const moderationService = require('../services/moderation.service');

const lettersModeration = (req, res, next) => {
  // We can choose to block immediately here or let the service handle it and flag it as under_review.
  // In the current architecture, we flag it as under_review instead of blocking the request outright,
  // so we'll just pass through. The moderation logic runs inside the service.
  
  next();
};

module.exports = lettersModeration;
