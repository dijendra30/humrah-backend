// controllers/userActivityController.js
//
// GET /api/users/activity
//
// Returns an aggregated activity dashboard for the authenticated user based on
// lightweight bookingRefs stored in the User document.
// bookings collection remains the single source of truth; refs are for fast stats.
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
//   byType: [                      // per-category breakdown
//     {
//       type:      String,         // ONE_TO_ONE | GROUP | MOVIE | EVENT | SOCIAL | PAID | FREE
//       total:     Number,
//       pending:   Number,
//       accepted:  Number,
//       completed: Number,
//     }
//   ],
//   recentBookings: [              // last 20, sorted newest first
//     {
//       bookingId:      String,
//       otherUserId:    String,
//       otherUserEmail: String,
//       status:         String,
//       type:           String,
//       createdAt:      String (ISO)
//     }
//   ],
//   earningsNote: String
// }

const User = require('../models/User');

// Canonical booking activity types the frontend understands.
// 'FREE' is the legacy fallback for refs that predate the enum.
const KNOWN_TYPES = ['ONE_TO_ONE', 'GROUP', 'MOVIE', 'EVENT', 'SOCIAL', 'PAID', 'FREE'];

exports.getUserActivity = async (req, res) => {
  try {
    // Pull only the bookingRefs field — lean for speed
    const user = await User.findById(req.userId)
      .select('bookingRefs')
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const refs = user.bookingRefs || [];

    // ── Compute global stats ───────────────────────────────────────────────
    const stats = {
      totalBookings:     refs.length,
      pendingBookings:   refs.filter(r => r.status === 'pending').length,
      acceptedBookings:  refs.filter(r => r.status === 'confirmed').length,
      completedBookings: refs.filter(r => r.status === 'completed').length,
      cancelledBookings: refs.filter(r => r.status === 'cancelled').length,
    };

    // ── Compute per-type breakdown ─────────────────────────────────────────
    // Group refs by their type. Unknown types get bucketed as their raw value
    // so future types don't silently disappear.
    const typeMap = {};
    for (const ref of refs) {
      const t = (ref.type || 'FREE').toUpperCase();
      if (!typeMap[t]) {
        typeMap[t] = { total: 0, pending: 0, accepted: 0, completed: 0 };
      }
      typeMap[t].total++;
      if (ref.status === 'pending')   typeMap[t].pending++;
      if (ref.status === 'confirmed') typeMap[t].accepted++;
      if (ref.status === 'completed') typeMap[t].completed++;
    }

    // Always return all known types so the frontend chips work even when empty
    const byType = KNOWN_TYPES.map(type => ({
      type,
      total:     typeMap[type]?.total     || 0,
      pending:   typeMap[type]?.pending   || 0,
      accepted:  typeMap[type]?.accepted  || 0,
      completed: typeMap[type]?.completed || 0,
    }));

    // Append any unknown types that appeared in refs but aren't in KNOWN_TYPES
    for (const [type, counters] of Object.entries(typeMap)) {
      if (!KNOWN_TYPES.includes(type)) {
        byType.push({ type, ...counters });
      }
    }

    // ── Recent bookings: last 20, newest first ─────────────────────────────
    const recentBookings = refs
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20)
      .map(r => ({
        bookingId:      r.bookingId.toString(),
        otherUserId:    r.otherUserId.toString(),
        otherUserEmail: r.otherUserEmail || null,
        status:         r.status,
        type:           (r.type || 'FREE').toUpperCase(),
        createdAt:      r.createdAt ? new Date(r.createdAt).toISOString() : null,
      }));

    return res.json({
      success: true,
      stats,
      byType,
      recentBookings,
      earningsNote: 'All bookings are currently FREE. Earnings coming soon.',
    });

  } catch (err) {
    console.error('[UserActivity] getUserActivity error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
