const mongoose = require('mongoose');

const launchConfigurationSchema = new mongoose.Schema({
  mode: {
    type: String,
    enum: ['WHITELIST', 'BLACKLIST', 'ALL_INDIA'],
    default: 'WHITELIST'
  },
  popupVersion: {
    type: Number,
    default: 1
  },
  newUserPopupEnabled: {
    type: Boolean,
    default: true
  },
  travelPopupEnabled: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

module.exports = mongoose.model('LaunchConfiguration', launchConfigurationSchema);
