const express = require('express');
const router = express.Router();
const User = require('../models/User');
const SafetyTicket = require('../models/SafetyTicket');
const RandomBooking = require('../models/RandomBooking');
const Post = require('../models/Post');
const { authenticate, adminOnly } = require('../middleware/auth');

// Helper to get Midnight IST in UTC
function getISTMidnightUTC() {
  const now = new Date();
  const istString = now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
  const istDate = new Date(istString);
  return new Date(Date.UTC(istDate.getFullYear(), istDate.getMonth(), istDate.getDate(), -5, -30, 0, 0));
}

// 1. Core KPIs
router.get('/kpis', authenticate, adminOnly, async (req, res) => {
  try {
    const todayIST = getISTMidnightUTC();
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

    const [
      totalUsers,
      activeUsersNow,
      newUsersToday,
      premiumUsers,
      verifiedUsers,
      totalCompanions,
      pendingCompanions,
      totalBookings,
      openSafetyCases,
      totalPosts
    ] = await Promise.all([
      User.countDocuments({ role: 'USER' }),
      User.countDocuments({ lastActive: { $gte: fifteenMinutesAgo } }),
      User.countDocuments({ createdAt: { $gte: todayIST } }),
      User.countDocuments({ 'subscription.isPremium': true }),
      User.countDocuments({ photoVerificationStatus: 'approved' }),
      User.countDocuments({ userType: 'COMPANION' }),
      User.countDocuments({ userType: 'COMPANION', status: 'PENDING_APPROVAL' }),
      RandomBooking ? RandomBooking.countDocuments() : Promise.resolve(0),
      SafetyTicket ? SafetyTicket.countDocuments({ status: { $in: ['OPEN', 'UNDER_REVIEW', 'ASSISTANCE_REQUESTED'] } }) : Promise.resolve(0),
      Post ? Post.countDocuments() : Promise.resolve(0)
    ]);

    res.json({
      success: true,
      data: {
        totalUsers, activeUsersNow, newUsersToday, premiumUsers, verifiedUsers,
        totalCompanions, pendingCompanions, totalBookings, openSafetyCases, totalPosts
      }
    });
  } catch (error) {
    console.error('KPI Analytics Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch KPIs.' });
  }
});

// 2. Demographics
router.get('/demographics', authenticate, adminOnly, async (req, res) => {
  try {
    const stateDist = await User.aggregate([
      { $match: { "questionnaire.state": { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$questionnaire.state", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const languageDist = await User.aggregate([
      { $match: { "questionnaire.languagePreference": { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$questionnaire.languagePreference", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 }
    ]);

    const cityDist = await User.aggregate([
      { $match: { "questionnaire.city": { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$questionnaire.city", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({
      success: true,
      data: {
        usersByState: stateDist.map(d => ({ state: d._id, users: d.count })),
        usersByLanguage: languageDist.map(d => ({ language: d._id, value: d.count })),
        topCities: cityDist.map(d => ({ city: d._id, users: d.count }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch demographics.' });
  }
});

// 3. Growth & Verification
router.get('/growth', authenticate, adminOnly, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const dailyRegistrations = await User.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
          users: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const verificationStatus = await User.aggregate([
      { $group: { _id: "$photoVerificationStatus", count: { $sum: 1 } } }
    ]);

    res.json({
      success: true,
      data: {
        dailyRegistrations: dailyRegistrations.map(d => ({ date: d._id, users: d.count })),
        verificationStatus: verificationStatus.map(d => ({ name: d._id || 'unverified', value: d.count }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch growth stats.' });
  }
});

// 4. Activity Feed
router.get('/activity', authenticate, adminOnly, async (req, res) => {
  try {
    const recentUsers = await User.find().sort({ createdAt: -1 }).limit(10).select('firstName lastName email createdAt profilePhoto role');
    const recentReports = SafetyTicket ? await SafetyTicket.find().sort({ createdAt: -1 }).limit(10).select('concernType status createdAt riskLevel') : [];
    
    const activityFeed = [
      ...recentUsers.map(u => ({
        id: u._id,
        type: 'NEW_USER',
        title: `New user joined: ${u.firstName} ${u.lastName}`,
        timestamp: u.createdAt,
        actor: u.email
      })),
      ...recentReports.map(r => ({
        id: r._id,
        type: 'SAFETY_REPORT',
        title: `New safety report: ${r.concernType}`,
        timestamp: r.createdAt,
        severity: r.riskLevel
      }))
    ].sort((a, b) => b.timestamp - a.timestamp).slice(0, 15);

    res.json({ success: true, data: { activityFeed } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch activity feed.' });
  }
});

// 5. Bookings (RandomBookings / Surprise Bookings)
router.get('/bookings', authenticate, adminOnly, async (req, res) => {
  if (!RandomBooking) return res.json({ success: true, data: { bookingTrends: [], statusDist: [] } });
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const bookingTrends = await RandomBooking.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
          bookings: { $sum: 1 },
          revenue: { $sum: 0 } // RandomBookings do not store totalAmount currently
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    const statusDist = await RandomBooking.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);

    res.json({
      success: true,
      data: {
        bookingTrends: bookingTrends.map(d => ({ date: d._id, bookings: d.count, revenue: d.revenue || 0 })),
        statusDist: statusDist.map(d => ({ name: d._id || 'unknown', value: d.count }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch bookings.' });
  }
});

// 6. Safety
router.get('/safety', authenticate, adminOnly, async (req, res) => {
  if (!SafetyTicket) return res.json({ success: true, data: { severityDist: [], typeDist: [] } });
  try {
    const severityDist = await SafetyTicket.aggregate([
      { $group: { _id: "$riskLevel", count: { $sum: 1 } } }
    ]);
    
    const typeDist = await SafetyTicket.aggregate([
      { $group: { _id: "$concernType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({
      success: true,
      data: {
        severityDist: severityDist.map(d => ({ name: d._id || 'UNRATED', value: d.count })),
        typeDist: typeDist.map(d => ({ name: d._id || 'UNKNOWN', value: d.count }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch safety.' });
  }
});

module.exports = router;
