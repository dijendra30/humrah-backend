// controllers/spotlight.controller.js - UPDATED to filter COMPANION users only
const User = require('../models/User');

/**
 * Get spotlight companions
 * 
 * ✅ CRITICAL FIX: Only show users with userType='COMPANION'
 * 
 * This ensures that:
 * - Regular members (userType='MEMBER') don't appear in spotlight
 * - Only users who selected "Yes, I'm interested" for companion mode appear
 * - Admin users (SUPER_ADMIN, SAFETY_ADMIN) don't appear unless they're also companions
 */
exports.getSpotlightCompanions = async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { 
      city, 
      state,
      interests,
      minRating,
      verifiedOnly,
      limit = 20,
      page = 1 
    } = req.query;

    // ✅ BASE FILTER: Only COMPANION users
    const filter = {
      _id: { $ne: currentUserId },  // Exclude current user
      userType: 'COMPANION',         // ✅ CRITICAL: Only companions
      status: 'ACTIVE',              // Only active users
      profilePhoto: { $ne: null }    // Must have profile photo
    };

    // Additional filters
    if (city) {
      filter['questionnaire.city'] = city;
    }

    if (state) {
      filter['questionnaire.state'] = state;
    }

    if (interests) {
      const interestArray = interests.split(',').map(i => i.trim());
      filter['questionnaire.interests'] = { $in: interestArray };
    }

    if (verifiedOnly === 'true') {
      filter.photoVerificationStatus = 'approved';
    }

    if (minRating) {
      filter['ratingStats.averageRating'] = { $gte: parseFloat(minRating) };
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Query companions
    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .sort({ 
        isPremium: -1,                      // Premium users first
        'ratingStats.averageRating': -1,    // Then by rating
        lastActive: -1                       // Then by recent activity
      })
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count for pagination
    const totalCompanions = await User.countDocuments(filter);
    const totalPages = Math.ceil(totalCompanions / parseInt(limit));

    // Format response
    const formattedCompanions = companions.map(companion => ({
      _id: companion._id,
      firstName: companion.firstName,
      lastName: companion.lastName,
      profilePhoto: companion.profilePhoto,
      verified: companion.verified,
      isPremium: companion.isPremium,
      userType: companion.userType,
      
      // Companion details
      tagline: companion.questionnaire?.tagline,
      price: companion.questionnaire?.price,
      availability: companion.questionnaire?.availability,
      openFor: companion.questionnaire?.openFor,
      city: companion.questionnaire?.city,
      state: companion.questionnaire?.state,
      interests: companion.questionnaire?.interests,
      
      // Ratings
      averageRating: companion.ratingStats?.averageRating || 0,
      totalRatings: companion.ratingStats?.totalRatings || 0,
      completedBookings: companion.ratingStats?.completedBookings || 0
    }));

    res.json({
      success: true,
      companions: formattedCompanions,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCompanions,
        hasMore: parseInt(page) < totalPages
      }
    });

  } catch (error) {
    console.error('Get spotlight companions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch companions'
    });
  }
};

/**
 * Get companion details by ID
 * 
 * ✅ Ensures requested user is actually a companion
 */
exports.getCompanionDetails = async (req, res) => {
  try {
    const { companionId } = req.params;

    const companion = await User.findOne({
      _id: companionId,
      userType: 'COMPANION',  // ✅ Must be companion
      status: 'ACTIVE'
    }).select('-password -emailVerificationOTP -fcmTokens');

    if (!companion) {
      return res.status(404).json({
        success: false,
        message: 'Companion not found'
      });
    }

    res.json({
      success: true,
      companion: companion.getPublicProfile()
    });

  } catch (error) {
    console.error('Get companion details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch companion details'
    });
  }
};

/**
 * Search companions with filters
 */
exports.searchCompanions = async (req, res) => {
  try {
    const { 
      query,
      city,
      state,
      minPrice,
      maxPrice,
      availability,
      interests,
      minRating,
      limit = 20 
    } = req.query;

    const filter = {
      _id: { $ne: req.userId },
      userType: 'COMPANION',  // ✅ Only companions
      status: 'ACTIVE'
    };

    // Text search
    if (query) {
      filter.$or = [
        { firstName: { $regex: query, $options: 'i' } },
        { lastName: { $regex: query, $options: 'i' } },
        { 'questionnaire.tagline': { $regex: query, $options: 'i' } },
        { 'questionnaire.bio': { $regex: query, $options: 'i' } }
      ];
    }

    // Location filters
    if (city) filter['questionnaire.city'] = city;
    if (state) filter['questionnaire.state'] = state;

    // Price range
    if (minPrice || maxPrice) {
      filter['questionnaire.price'] = {};
      // Note: Price is stored as string, would need parsing logic here
    }

    // Availability
    if (availability) {
      filter['questionnaire.availability'] = availability;
    }

    // Interests
    if (interests) {
      const interestArray = interests.split(',');
      filter['questionnaire.interests'] = { $in: interestArray };
    }

    // Rating
    if (minRating) {
      filter['ratingStats.averageRating'] = { $gte: parseFloat(minRating) };
    }

    const companions = await User.find(filter)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium')
      .sort({ 'ratingStats.averageRating': -1, lastActive: -1 })
      .limit(parseInt(limit));

    res.json({
      success: true,
      companions,
      count: companions.length
    });

  } catch (error) {
    console.error('Search companions error:', error);
    res.status(500).json({
      success: false,
      message: 'Search failed'
    });
  }
};
