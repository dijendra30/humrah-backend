const mongoose = require('mongoose');

const legalVersionSchema = new mongoose.Schema({
  documentType: {
    type: String,
    enum: ['TERMS', 'PRIVACY'],
    required: true,
    unique: true
  },
  
  currentVersion: {
    type: String,
    required: true
  },
  
  url: {
    type: String,
    required: true
  },
  
  effectiveDate: {
    type: Date,
    required: true
  },
  
  previousVersions: [{
    version: String,
    url: String,
    effectiveDate: Date,
    deprecatedAt: Date
  }],
  
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  changeNotes: {
    type: String
  }
  
}, { timestamps: true });

module.exports = mongoose.model('LegalVersion', legalVersionSchema);
