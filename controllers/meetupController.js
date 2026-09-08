// controllers/meetupController.js
// -----------------------------------------------------------------------------
// R7.1 — the HTTP surface for Meetups. Exactly one endpoint (spec §17):
//
//   POST /api/rooms/:roomId/meetups
//
// The controller is deliberately thin. It does not decide anything: it maps a
// request to the proposal service and a service result to a status code. Every
// rule lives in services/meetup/.
//
// NOTHING IS READ FROM THE REQUEST BODY. Room age, membership, member count,
// engagement state, eligibility, Room ownership and the participant list are all
// derived server-side; a client cannot assert any of them. The only client inputs
// are the URL's :roomId (shape-validated by roomGuards.validateRoomId) and the
// optional Idempotency-Key header.
// -----------------------------------------------------------------------------
'use strict';

const { createMeetupProposal } = require('../services/meetup/meetupProposalService');
const { MEETUP_ERROR } = require('../services/meetup/meetupTelemetry');

/**
 * Deterministic error code -> HTTP status.
 *
 * MEETUP_NOT_ALLOWED is 403 for every one of its causes — feature disabled,
 * account restricted, block relationship — so the response cannot be used to
 * distinguish them. That is the point: it is the safety-preserving code.
 */
const STATUS_BY_CODE = Object.freeze({
  [MEETUP_ERROR.ROOM_NOT_FOUND]: 404,
  [MEETUP_ERROR.NOT_ROOM_MEMBER]: 403,
  [MEETUP_ERROR.MEETUP_NOT_ALLOWED]: 403,
  [MEETUP_ERROR.ROOM_TOO_YOUNG]: 400,
  [MEETUP_ERROR.ROOM_NOT_ELIGIBLE]: 400,
  [MEETUP_ERROR.INSUFFICIENT_MEMBERS]: 400,
  [MEETUP_ERROR.MEETUP_EXPIRED]: 410,
  [MEETUP_ERROR.MEETUP_ALREADY_ACTIVE]: 409,
  [MEETUP_ERROR.ROOM_MEETUP_COOLDOWN]: 429,
  [MEETUP_ERROR.MEETUP_RATE_LIMITED]: 429,
});

/**
 * POST /api/rooms/:roomId/meetups
 * Creates a Meetup proposal. Idempotent via the Idempotency-Key header.
 */
exports.createMeetupProposal = async (req, res) => {
  // Same maintenance switch the rest of the Room API honours.
  if (process.env.ENABLE_HUMRAH_ROOMS === 'false') {
    return res.status(503).json({
      success: false,
      code: MEETUP_ERROR.MEETUP_NOT_ALLOWED,
      message: 'Humrah Rooms are currently undergoing maintenance.',
    });
  }

  try {
    const result = await createMeetupProposal({
      roomId: req.params.roomId,
      userId: req.userId,                      // from the JWT, never the body
      idempotencyKey: req.get('Idempotency-Key'),
    });

    if (!result.ok) {
      const status = STATUS_BY_CODE[result.code] || 400;
      const body = { success: false, code: result.code, message: result.message };
      // Surfaced only where they help the client act, and never sensitive:
      // a Meetup id the user can already see, and their own quota position.
      if (result.meetupId) body.meetupId = result.meetupId;
      if (result.status) body.meetupStatus = result.status;
      if (result.cooldownHoursRemaining !== undefined) body.cooldownHoursRemaining = result.cooldownHoursRemaining;
      if (result.roomAgeHours !== undefined) body.roomAgeHours = result.roomAgeHours;
      if (result.memberCount !== undefined) body.memberCount = result.memberCount;
      return res.status(status).json(body);
    }

    // A replay returns 200 with the original Meetup; a fresh creation returns 201.
    // Both carry an identical `meetup` object, so a retrying client cannot tell
    // the difference in the data it consumes.
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      meetup: result.meetup,
    });

  } catch (error) {
    console.error('[createMeetupProposal error]', error);
    return res.status(500).json({
      success: false,
      code: MEETUP_ERROR.MEETUP_NOT_ALLOWED,
      message: 'Server error creating the Meetup',
    });
  }
};

module.exports.STATUS_BY_CODE = STATUS_BY_CODE;
