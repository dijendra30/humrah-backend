// routes/safetyTickets.js
// Auth is applied globally in server.js — DO NOT add auth per-route here.
// All routes are reporter-scoped (user can only access their own tickets).

'use strict';

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/safetyTicketController');
const { body, param, query, validationResult } = require('express-validator');

// ─────────────────────────────────────────────────────────────────────────────
// Validation middleware
// ─────────────────────────────────────────────────────────────────────────────
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }
    next();
};

const ticketIdParam = param('ticketId')
    .matches(/^HST-\d{8}-\d{4}$/)
    .withMessage('Invalid ticket ID format.');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/safety-tickets  — list the caller's tickets (for Safety Team chat list)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', controller.listTickets);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/safety-tickets/check?reportedUserId=xxx
// BUG #2 FIX: Pre-form duplicate check — returns { exists, ticketId, status }.
// MUST be declared BEFORE /:ticketId so Express does not try to parse "check"
// as a ticket ID parameter.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
    '/check',
    [
        query('reportedUserId')
            .optional({ nullable: true })
            .isMongoId()
            .withMessage('reportedUserId must be a valid ID.')
    ],
    validate,
    controller.checkActiveTicket
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets
// Submit a new safety concern → create ticket → Gemini → Telegram → bot message
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    '/',
    [
        body('concernType')
            .isIn(['felt_uncomfortable', 'inappropriate_message',
                   'felt_pressured_or_unsafe', 'something_else'])
            .withMessage('Invalid concern type.'),
        body('note')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Note must be 500 characters or fewer.'),
        body('reportedUserId')
            .optional({ nullable: true })
            .isMongoId()
            .withMessage('reportedUserId must be a valid ID.')
    ],
    validate,
    controller.submitConcern
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/safety-tickets/:ticketId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:ticketId', [ticketIdParam], validate, controller.getTicket);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/safety-tickets/:ticketId/messages
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:ticketId/messages', [ticketIdParam], validate, controller.getMessages);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets/:ticketId/messages
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    '/:ticketId/messages',
    [
        ticketIdParam,
        body('content').isString().notEmpty().isLength({ max: 5000 })
            .withMessage('Message content is required (max 5000 chars).')
    ],
    validate,
    controller.sendMessage
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets/:ticketId/i-am-safe
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:ticketId/i-am-safe',        [ticketIdParam], validate, controller.markIAmSafe);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets/:ticketId/need-assistance
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:ticketId/need-assistance',  [ticketIdParam], validate, controller.requestAssistance);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/safety-tickets/:ticketId/share-location
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    '/:ticketId/share-location',
    [
        ticketIdParam,
        body('latitude').isFloat({ min: -90,  max: 90  }).withMessage('Invalid latitude.'),
        body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude.')
    ],
    validate,
    controller.shareLocation
);

module.exports = router;
