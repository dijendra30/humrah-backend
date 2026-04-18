// controllers/userActivityController.js
//
// GET /api/user/activity
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
//   earningsNote: "All bookings are currently FREE. Earnings coming soon."
// }

const User = require('../models/User');

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

    // ── Compute stats from in-memory array (no extra DB query) ────────────
    const stats = {
      totalBookings:     refs.length,
      pendingBookings:   refs.filter(r => r.status === 'pending').length,
      acceptedBookings:  refs.filter(r => r.status === 'confirmed').length,
      completedBookings: refs.filter(r => r.status === 'completed').length,
      cancelledBookings: refs.filter(r => r.status === 'cancelled').length,
    };

    // ── Recent bookings: last 20, newest first ─────────────────────────────
    const recentBookings = refs
      .slice()                                         // don't mutate original
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20)
      .map(r => ({
        bookingId:      r.bookingId.toString(),
        otherUserId:    r.otherUserId.toString(),
        otherUserEmail: r.otherUserEmail || null,
        status:         r.status,
        type:           r.type || 'FREE',
        createdAt:      r.createdAt ? new Date(r.createdAt).toISOString() : null,
      }));

    return res.json({
      success: true,
      stats,
      recentBookings,
      earningsNote: 'All bookings are currently FREE. Earnings coming soon.',
    });

  } catch (err) {
    console.error('[UserActivity] getUserActivity error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
