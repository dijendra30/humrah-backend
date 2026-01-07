const User = require('../models/User');

exports.getSpotlightCompanions = async (req, res) => {
  try {
    const currentUserId = req.userId;

    const currentUser = await User.findById(currentUserId)
      .select('questionnaire');

    if (!currentUser) {
      return res.status(404).json({ success: false });
    }

    const userHangouts =
      currentUser.questionnaire?.hangoutPreferences || [];

    const companions = await User.find({
      _id: { $ne: currentUserId },
      role: 'USER',
      verified: true
    });

    const mapped = companions.map(u => {
      const otherHangouts =
        u.questionnaire?.hangoutPreferences || [];

      const sharedHangouts = userHangouts.filter(h =>
        otherHangouts.includes(h)
      );

      return {
        id: u._id.toString(),
        name: `${u.firstName} ${u.lastName}`.trim(),
        profilePhoto: u.profilePhoto || null,
        sharedHangouts,
        overlapCount: sharedHangouts.length,

        bio: u.questionnaire?.bio || null,
        availability: u.questionnaire?.availability || null,
        availableTimes: u.questionnaire?.availableTimes || [],
        city: u.questionnaire?.city || null,
        state: u.questionnaire?.state || null,
        languagePreference: u.questionnaire?.languagePreference || null,
        comfortZones: u.questionnaire?.comfortZones || [],
        vibeWords: u.questionnaire?.vibeWords || [],
        becomeCompanion: u.questionnaire?.becomeCompanion || null,
        price: u.questionnaire?.price || null,
        tagline: u.questionnaire?.tagline || null,
        photoVerificationStatus: u.photoVerificationStatus || 'pending'
      };
    });

    mapped.sort((a, b) => b.overlapCount - a.overlapCount);

    res.json({
      success: true,
      count: mapped.length,
      companions: mapped
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};
