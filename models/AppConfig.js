const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema({
  branding: {
    remoteBrandingEnabled: { type: Boolean, default: false },
    launcher: {
      mode: { type: String, enum: ['DEFAULT', 'BUNDLED_VARIANT', 'UPDATE_REQUIRED'], default: 'DEFAULT' },
      variantId: { type: String, default: null }
    },
    splash: {
      enabled: { type: Boolean, default: false },
      logoUrl: { type: String, default: null },
      version: { type: Number, default: 1 }
    },
    activeVersion: { type: Number, default: 1 },
    updatedAt: { type: Date, default: Date.now }
  },
  draft: {
    splashLogoUrl: { type: String, default: null },
    createdAt: { type: Date, default: null }
  },
  // Deprecated fields for migration
  logoUrl: { type: String, default: undefined },
  logoVersion: { type: Number, default: undefined },
  draftLogoUrl: { type: String, default: undefined },
  draftCreatedAt: { type: Date, default: undefined }
}, { timestamps: true, strict: false });

// Pre-save hook to ensure migration of old fields if they exist
appConfigSchema.pre('save', function(next) {
  // If old flat fields exist, migrate them to new structure
  if (this.logoUrl !== undefined && this.branding.splash.logoUrl === null) {
    this.branding.remoteBrandingEnabled = true;
    this.branding.splash.enabled = true;
    this.branding.splash.logoUrl = this.logoUrl;
    this.branding.splash.version = this.logoVersion || 1;
    this.branding.activeVersion = this.logoVersion || 1;
    
    // Unset old fields
    this.logoUrl = undefined;
    this.logoVersion = undefined;
  }
  
  if (this.draftLogoUrl !== undefined && this.draft.splashLogoUrl === null) {
    this.draft.splashLogoUrl = this.draftLogoUrl;
    this.draft.createdAt = this.draftCreatedAt || new Date();
    
    // Unset old draft fields
    this.draftLogoUrl = undefined;
    this.draftCreatedAt = undefined;
  }
  
  next();
});

module.exports = mongoose.model('AppConfig', appConfigSchema);
