const launchRegionService = require('../services/launchRegionService');

exports.getLaunchRegionStatus = async (req, res) => {
  try {
    const statusResult = await launchRegionService.getUserRegionStatus(req.user.id);
    res.status(200).json({
      success: true,
      data: statusResult
    });
  } catch (error) {
    console.error('Error fetching launch region status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve launch region status'
    });
  }
};
