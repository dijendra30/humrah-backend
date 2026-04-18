// controllers/userActivityController.js
//
// GET /api/users/activity
//
// Returns an aggregated activity dashboard for the authenticated user.
//
// DATA SOURCES (queried directly — bookingRefs is NOT used):
//   1. Booking        → companionId === userId  → type: ONE_TO_ONE
//   2. RandomBooking  → initiatorId === userId  → type: ONE_TO_ONE
//   3. MovieSession   → participants includes userId → type: MOVIE
//
// Status mapping:
//   Booking:       'pending' | 'confirmed' | 'cancelled' | 'completed'
//   RandomBooking: 'PENDING' → pending | 'MATCHED' → confirmed | 'COMPLETED' → completed | 'CANCELLED' → cancelled
//   MovieSession:  'active'  → confirmed | 'expired' → completed
//
// Response shape:
// {
//   success: true,
//   stats: {
//     totalBookings:     Number,
//     acceptedBookings:  Number,   // status === 'confirmed'
//     completedBookings: Number,   // status === 'completed'
//     pendingBookings:   Number,   // status === 'pending'
//     cancelledBookings: Number,   // status === 'cancelled'
//   },
//   byType: [
//     { type: String, total: Number, pending: Number, accepted: Number, completed: Number }
//   ],
//   recentBookings: [
//     { bookingId, otherUserId, otherUserEmail, status, type, createdAt }
//   ],
//   earningsNote: String
// }

const mongoose = require('mongoose');
const Booking       = require('../models/Booking');
const RandomBooking = require('../models/RandomBooking');
const MovieSession  = require('../models/MovieSession');
const User          = require('../models/User');

// Canonical types the frontend understands
const KNOWN_TYPES = ['ONE_TO_ONE', 'GROUP', 'MOVIE', 'EVENT', 'SOCIAL', 'PAID', 'FREE'];

// ── status normalisation ──────────────────────────────────────────────────────
function normaliseRandomBookingStatus(rawStatus) {
  switch ((rawStatus || '').toUpperCase()) {
    case 'MATCHED':   return 'confirmed';
    case 'COMPLETED': return 'completed';
    case 'CANCELLED':
    case 'EXPIRED':   return 'cancelled';
    default:          return 'pending';
  }
}

function normaliseMovieSessionStatus(rawStatus) {
  // active movie sessions count as accepted/confirmed
  // expired movie sessions count as completed
  return rawStatus === 'expired' ? 'completed' : 'confirmed';
}

// ── aggregate ref list into stats + byType + recent ──────────────────────────
function buildResponse(refs) {
  const stats = {
    totalBookings:     refs.length,
    pendingBookings:   0,
    acceptedBookings:  0,
    completedBookings: 0,
    cancelledBookings: 0,
  };

  const typeMap = {};

  for (const ref of refs) {
    // global stats
    if (ref.status === 'pending')   stats.pendingBookings++;
    if (ref.status === 'confirmed') stats.acceptedBookings++;
    if (ref.status === 'completed') stats.completedBookings++;
    if (ref.status === 'cancelled') stats.cancelledBookings++;

    // per-type
    const t = ref.type;
    if (!typeMap[t]) typeMap[t] = { total: 0, pending: 0, accepted: 0, completed: 0 };
    typeMap[t].total++;
    if (ref.status === 'pending')   typeMap[t].pending++;
    if (ref.status === 'confirmed') typeMap[t].accepted++;
    if (ref.status === 'completed') typeMap[t].completed++;
  }

  const byType = KNOWN_TYPES.map(type => ({
    type,
    total:     typeMap[type]?.total     || 0,
    pending:   typeMap[type]?.pending   || 0,
    accepted:  typeMap[type]?.accepted  || 0,
    completed: typeMap[type]?.completed || 0,
  }));

  // append unknown types
  for (const [type, counters] of Object.entries(typeMap)) {
    if (!KNOWN_TYPES.includes(type)) byType.push({ type, ...counters });
  }

  // recent: last 20, newest first
  const recentBookings = refs
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);

  return { stats, byType, recentBookings };
}

exports.getUserActivity = async (req, res) => {
  try {
    const userId = req.userId;
    const userObjId = new mongoose.Types.ObjectId(userId);

    console.log(`[UserActivity] fetching for userId=${userId}`);

    // ── 1. Companion bookings (user is the companion/host) ────────────────────
    // These are the classic Booking model entries where companionId === userId
    const companionBookings = await Booking.find({ companionId: userObjId })
      .select('_id userId companionId status createdAt')
      .populate('userId', 'email')
      .lean();

    const companionRefs = companionBookings.map(b => ({
      bookingId:      b._id.toString(),
      otherUserId:    b.userId?._id?.toString() || b.userId?.toString() || '',
      otherUserEmail: b.userId?.email || null,
      status:         b.status || 'pending',
      type:           'ONE_TO_ONE',
      createdAt:      b.createdAt ? new Date(b.createdAt).toISOString() : null,
    }));

    console.log(`[UserActivity] companionBookings: ${companionRefs.length}`);

    // ── 2. RandomBookings (user is the initiator) ─────────────────────────────
    const randomBookings = await RandomBooking.find({ initiatorId: userObjId })
      .select('_id initiatorId acceptorId status createdAt')
      .populate('acceptorId', 'email')
      .lean();

    const randomRefs = randomBookings.map(rb => ({
      bookingId:      rb._id.toString(),
      otherUserId:    rb.acceptorId?._id?.toString() || rb.acceptorId?.toString() || '',
      otherUserEmail: rb.acceptorId?.email || null,
      status:         normaliseRandomBookingStatus(rb.status),
      type:           'ONE_TO_ONE',
      createdAt:      rb.createdAt ? new Date(rb.createdAt).toISOString() : null,
    }));

    console.log(`[UserActivity] randomBookings (initiator): ${randomRefs.length}`);

    // ── 3. MovieSessions the user is a participant in ─────────────────────────
    const movieSessions = await MovieSession.find({ participants: userObjId })
      .select('_id createdBy participants status createdAt movieTitle')
      .lean();

    const movieRefs = movieSessions.map(ms => {
      // otherUser = first participant who is NOT the current user
      const others = (ms.participants || []).filter(
        p => p.toString() !== userId
      );
      const otherUserId = others[0]?.toString() || '';
      return {
        bookingId:      ms._id.toString(),
        otherUserId,
        otherUserEmail: null,   // not worth an extra lookup — MovieSession has no email
        status:         normaliseMovieSessionStatus(ms.status),
        type:           'MOVIE',
        createdAt:      ms.createdAt ? new Date(ms.createdAt).toISOString() : null,
      };
    });

    console.log(`[UserActivity] movieSessions (participant): ${movieRefs.length}`);

    // ── Merge all refs ────────────────────────────────────────────────────────
    const allRefs = [...companionRefs, ...randomRefs, ...movieRefs];
    console.log(`[UserActivity] total refs: ${allRefs.length}`);

    const { stats, byType, recentBookings } = buildResponse(allRefs);
    console.log(`[UserActivity] stats:`, stats);

    return res.json({
      success: true,
      stats,
      byType,
      recentBookings,
      earningsNote: 'All bookings are currently FREE. Earnings coming soon.',
    });

  } catch (err) {
    console.error('[UserActivity] getUserActivity error:', err.message, err.stack);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
