// controllers/liveLocationController.js
const crypto        = require('crypto');
const LiveLocation  = require('../models/LiveLocation');
const TrustedContact = require('../models/TrustedContact');

// ─── helpers ────────────────────────────────────────────────────────────────

function detectMovement(speedKmh) {
  // Updated thresholds: 0–2 Stationary, 2–7 Walking, 7–15 Running, 15+ Driving
  if (!speedKmh || speedKmh < 2)  return 'Stationary';
  if (speedKmh < 7)               return 'Walking';
  if (speedKmh < 15)              return 'Running';
  return 'Driving';
}

function secureSessionId() {
  // 24 bytes → 48 hex chars — URL-safe, unguessable
  return crypto.randomBytes(24).toString('hex');
}

// Clean tracking URL — no ugly query strings, no .html extension visible
// https://humrah.in/live/<sessionId>
function buildTrackingUrl(sessionId) {
  return `https://humrah.in/humrah-live-safety.html?session=${sessionId}`;
}

// ─── START ───────────────────────────────────────────────────────────────────
// POST /api/live-location/start
// Body (optional): { isEmergency: true }
// Requires: authenticated user (req.userId set by middleware)
exports.start = async (req, res) => {
  try {
    const userId      = req.userId;
    const isEmergency = req.body?.isEmergency === true;

    // Fetch trusted contact silently (non-blocking if missing)
    const contact = await TrustedContact.findOne({ userId }).lean();

    // Fetch user's own name so Android can use it in the SMS template
    const User = require('mongoose').model('User');
    const user = await User.findById(userId).select('firstName lastName').lean();
    const userName = user
      ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
      : 'Someone';

    // Expire any existing active sessions for this user before creating new one
    await LiveLocation.updateMany(
      { userId, isActive: true },
      { $set: { isActive: false, expiresAt: new Date(), revokedAt: new Date() } }
    );

    const sessionId = secureSessionId();
    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h

    await LiveLocation.create({
      sessionId,
      userId,
      trustedContactName:  contact?.name  || '',
      trustedContactPhone: contact?.phone || '',
      isEmergency,
      isActive:  true,
      startedAt: new Date(),
      updatedAt: new Date(),
      expiresAt,
    });

    const trackingUrl = buildTrackingUrl(sessionId);

    return res.json({
      success:     true,
      sessionId,
      trackingUrl,
      isEmergency,
      userName,              // sharer's own name — used in SMS template
      trustedContact: contact
        ? { name: contact.name, phone: contact.phone }
        : null,
      expiresAt,
    });
  } catch (err) {
    console.error('[LiveLocation] start error:', err);
    return res.status(500).json({ success: false, message: 'Could not start live location session.' });
  }
};

// ─── UPDATE ──────────────────────────────────────────────────────────────────
// POST /api/live-location/update
// Body: { sessionId, lat, lng, accuracy?, speed?, batteryLevel? }
// Requires: authenticated user (ownership validated)
exports.update = async (req, res) => {
  try {
    const { sessionId, lat, lng, accuracy, speed, batteryLevel } = req.body;

    if (!sessionId || lat == null || lng == null) {
      return res.status(400).json({ success: false, message: 'sessionId, lat, lng are required.' });
    }

    const session = await LiveLocation.findOne({ sessionId, userId: req.userId });

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    if (!session.isActive || session.expiresAt < new Date()) {
      return res.status(410).json({ success: false, message: 'Session has expired.' });
    }

    const speedKmh = typeof speed === 'number' ? speed : 0;

    await LiveLocation.updateOne(
      { sessionId },
      {
        $set: {
          lat,
          lng,
          accuracy:     accuracy ?? session.accuracy,
          speed:        speedKmh,
          batteryLevel: batteryLevel ?? session.batteryLevel,
          movementType: detectMovement(speedKmh),
          updatedAt:    new Date(),
        }
      }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('[LiveLocation] update error:', err);
    return res.status(500).json({ success: false, message: 'Could not update location.' });
  }
};

// ─── GET ─────────────────────────────────────────────────────────────────────
// GET /api/live-location/:sessionId
// PUBLIC (no auth) — trusted contact polls this from browser
exports.get = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await LiveLocation.findOne({ sessionId })
      .populate('userId', 'firstName lastName profilePhoto')
      .lean();

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const isExpired = !session.isActive || session.expiresAt < new Date();

    const name = session.userId
      ? `${session.userId.firstName || ''} ${session.userId.lastName || ''}`.trim()
      : 'Unknown';

    // ── STALENESS GUARD ──────────────────────────────────────────────────────
    // Service sends GPS every 20 s. If updatedAt is older than 2 minutes,
    // the service has stopped (user stopped it, app crashed, phone died).
    // Auto-expire so the website shows the ended modal on the very next poll.
    if (!isExpired && session.updatedAt) {
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
      if (session.updatedAt < twoMinAgo) {
        await LiveLocation.updateOne(
          { sessionId },
          { $set: { isActive: false, expiresAt: new Date(), lat: null, lng: null } }
        );
        return res.json({
          success: true,
          data: { name, profilePhoto: session.userId?.profilePhoto || null, isExpired: true }
        });
      }
    }

    return res.json({
      success: true,
      data: {
        name,
        profilePhoto: session.userId?.profilePhoto || null,
        lat:          session.lat,
        lng:          session.lng,
        accuracy:     session.accuracy,
        speed:        session.speed,
        movementType: session.movementType,
        batteryLevel: session.batteryLevel,
        isEmergency:  session.isEmergency,
        updatedAt:    session.updatedAt,
        startedAt:    session.startedAt,
        isExpired,
      }
    });
  } catch (err) {
    console.error('[LiveLocation] get error:', err);
    return res.status(500).json({ success: false, message: 'Could not fetch location.' });
  }
};

// ─── STOP ────────────────────────────────────────────────────────────────────
// POST /api/live-location/stop
// Body: { sessionId }
// Requires: authenticated user (ownership validated)
exports.stop = async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required.' });
    }

    const result = await LiveLocation.updateOne(
      { sessionId, userId: req.userId },
      {
        $set: {
          isActive:  false,
          expiresAt: new Date(),
          revokedAt: new Date(),
          // Wipe coordinates immediately — trusted contact's browser will get
          // null lat/lng + isExpired:true on the very next poll, so no stale
          // location is ever served after the user stops sharing.
          lat:      null,
          lng:      null,
          accuracy: null,
          speed:    0,
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    return res.json({ success: true, message: 'Live location sharing stopped.' });
  } catch (err) {
    console.error('[LiveLocation] stop error:', err);
    return res.status(500).json({ success: false, message: 'Could not stop session.' });
  }
};
