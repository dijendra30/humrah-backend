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

exports.completeLaunchPopup = async (req, res) => {
  try {
    const payload = {
      unsupportedRegionAccepted: req.body.unsupportedRegionAccepted,
      popupVersionSeen: req.body.popupVersionSeen
    };
    
    await launchRegionService.completeLaunchPopup(req.user.id, payload);
    
    res.status(200).json({
      success: true,
      message: 'Launch popup completed successfully'
    });
  } catch (error) {
    console.error('Error completing launch popup:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to complete launch popup'
    });
  }
};
