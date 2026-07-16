const LaunchRegion = require('../models/LaunchRegion');
const RegionDemand = require('../models/RegionDemand');

exports.getAllRegions = async (req, res) => {
  try {
    const regions = await LaunchRegion.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: regions });
  } catch (error) {
    console.error('Error in getAllRegions:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.createRegion = async (req, res) => {
  try {
    const region = await LaunchRegion.create(req.body);
    res.status(201).json({ success: true, data: region });
  } catch (error) {
    console.error('Error in createRegion:', error);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Region already exists' });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.updateRegion = async (req, res) => {
  try {
    const region = await LaunchRegion.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });
    if (!region) {
      return res.status(404).json({ success: false, message: 'Region not found' });
    }
    res.status(200).json({ success: true, data: region });
  } catch (error) {
    console.error('Error in updateRegion:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.deleteRegion = async (req, res) => {
  try {
    const region = await LaunchRegion.findByIdAndDelete(req.params.id);
    if (!region) {
      return res.status(404).json({ success: false, message: 'Region not found' });
    }
    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    console.error('Error in deleteRegion:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getDemand = async (req, res) => {
  try {
    const demands = await RegionDemand.find().sort({ totalUsers: -1 });
    res.status(200).json({ success: true, data: demands });
  } catch (error) {
    console.error('Error in getDemand:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
