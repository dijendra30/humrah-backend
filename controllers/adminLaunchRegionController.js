const LaunchRegion = require('../models/LaunchRegion');
const RegionDemand = require('../models/RegionDemand');
const LaunchConfiguration = require('../models/LaunchConfiguration');
const regionMatcher = require('../services/regionMatcher');

const isDev = process.env.NODE_ENV !== 'production';

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
  if (isDev) console.log('\n[DEV] createRegion request:', req.body);
  try {
    const region = await LaunchRegion.create(req.body);
    if (isDev) console.log('[DEV] Region created successfully:', region._id);
    res.status(201).json({ success: true, data: region });
  } catch (error) {
    if (isDev) console.error('[DEV] createRegion error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: `${req.body.area || 'This area'} already exists under ${req.body.state || 'this state'}.` });
    }
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }

    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.updateRegion = async (req, res) => {
  if (isDev) console.log(`\n[DEV] updateRegion request [${req.params.id}]:`, req.body);
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
    if (isDev) console.error('[DEV] updateRegion error:', error);

    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'This area already exists under this state.' });
    }
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }

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

exports.getConfig = async (req, res) => {
  try {
    let config = await LaunchConfiguration.findOne();
    if (!config) {
      if (isDev) console.log('[DEV] Config not found, creating default LaunchConfiguration...');
      config = await LaunchConfiguration.create({
        mode: 'WHITELIST',
        popupVersion: 1,
        newUserPopupEnabled: true,
        travelPopupEnabled: true
      });
    }
    res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Error in getConfig:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.updateConfig = async (req, res) => {
  if (isDev) console.log('\n[DEV] updateConfig request:', req.body);
  try {
    let config = await LaunchConfiguration.findOne();
    if (!config) {
      config = new LaunchConfiguration(req.body);
      await config.save();
    } else {
      config = await LaunchConfiguration.findByIdAndUpdate(config._id, req.body, { new: true, runValidators: true });
    }
    res.status(200).json({ success: true, data: config });
  } catch (error) {
    if (isDev) console.error('[DEV] updateConfig error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.simulate = async (req, res) => {
  const { state, area } = req.body;
  if (isDev) console.log(`\n[DEV] SIMULATOR REQUEST -> State: ${state}, Area: ${area}`);
  
  if (!state || !area) {
    return res.status(400).json({ success: false, message: 'State and Area are required for simulation.' });
  }

  try {
    const result = await regionMatcher.getRegionSupport(state, area);
    if (isDev) console.log(`[DEV] SIMULATOR RESULT -> Supported: ${result.supported}, Status: ${result.status}`);
    
    // The frontend expects the standard payload string if success
    const message = result.supported 
      ? `Success! Region is SUPPORTED under current configuration (Status: ${result.status}).`
      : `Region is UNSUPPORTED under current configuration (Status: ${result.status}).`;

    res.status(200).json({ success: true, data: result, message });
  } catch (error) {
    if (isDev) console.error('[DEV] Simulator error:', error);
    res.status(500).json({ success: false, message: 'Server error during simulation.' });
  }
};
