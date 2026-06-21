// config/cloudinary.js - Cloudinary Configuration (Updated with Verification Support)
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure Multer for Memory Storage (no disk writes)
const storage = multer.memoryStorage();

// Configure Multer Upload for Images
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Configure Multer Upload for Videos (Verification)
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB limit for videos (increased from 10MB)
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'), false);
    }
  }
});

// Helper function to upload buffer to Cloudinary (Images)
const uploadBuffer = async (buffer, folder = 'humrah') => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: folder,
        resource_type: 'image',
        transformation: [
          { width: 1000, height: 1000, crop: 'limit' },
          { quality: 'auto:good' }
        ]
      },
      (error, result) => {
        if (error) {
          console.error(`❌ [Cloudinary Upload] Buffer upload failed:`, error);
          reject(error);
        } else {
          console.log(`✅ [Cloudinary Upload] Buffer uploaded successfully: ${result.public_id}`);
          resolve({
            url: result.secure_url,
            publicId: result.public_id
          });
        }
      }
    );
    uploadStream.end(buffer);
  });
};

// Helper function to upload verification video (Temporary, Authenticated)
const uploadVerificationVideo = async (buffer, sessionId) => {
  return new Promise((resolve, reject) => {
    console.log(`📤 [Cloudinary] Uploading verification video for session ${sessionId}`);
    console.log(`📦 [Cloudinary] Video size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `verification-temp/${sessionId}`,
        resource_type: 'video',
        type: 'authenticated', // Private, not public
        invalidate: true,
        eager: '', // No transformations
        eager_async: false,
        backup: false,
        overwrite: false,
        timeout: 120000 // 2 minute timeout
      },
      (error, result) => {
        if (error) {
          console.error(`❌ [Cloudinary] Upload failed:`, error);
          reject(error);
        } else {
          console.log(`✅ [Cloudinary] Video uploaded successfully: ${result.public_id}`);
          resolve({
            url: result.secure_url,
            publicId: result.public_id
          });
        }
      }
    );
    
    uploadStream.end(buffer);
  });
};

// Helper function to delete image from Cloudinary
const deleteImage = async (publicId) => {
  try {
    console.log(`🗑️ [Cloudinary Delete Image] Attempting to delete publicId: ${publicId}`);
    const result = await cloudinary.uploader.destroy(publicId);
    console.log(`✅ [Cloudinary Delete Image] Response for ${publicId}:`, result);
    if (result && result.result === 'not found') {
      console.warn(`⚠️ [Cloudinary Delete Image] Warning: Image ${publicId} was not found on Cloudinary (possibly already deleted).`);
    }
    return true;
  } catch (error) {
    console.error(`❌ [Cloudinary Delete Image] Error deleting image ${publicId}:`, error);
    return false;
  }
};

// Helper function to delete video from Cloudinary
const deleteVideo = async (publicId) => {
  try {
    console.log(`[DELETE VIDEO CALLED]`);
    console.log(`[VIDEO PUBLIC ID] ${publicId}`);
    
    // NOTE: Added type: 'authenticated' because verification videos are uploaded as authenticated
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'video',
      type: 'authenticated',
      invalidate: true
    });
    
    console.log(`[CLOUDINARY DELETE RESPONSE]`, result);
    
    if (result && result.result === 'not found') {
      console.warn(`⚠️ [Cloudinary Delete Video] Warning: Video ${publicId} was not found on Cloudinary (possibly already deleted).`);
    }
    return true;
  } catch (error) {
    console.error(`❌ [Cloudinary Delete Video] Error deleting video ${publicId}:`, error);
    return false;
  }
};

// Helper function to upload base64 image
const uploadBase64 = async (base64String, folder = 'humrah') => {
  try {
    const result = await cloudinary.uploader.upload(base64String, {
      folder: folder,
      resource_type: 'image',
      transformation: [
        { width: 1000, height: 1000, crop: 'limit' },
        { quality: 'auto:good' }
      ]
    });
    console.log(`✅ [Cloudinary Upload] Base64 uploaded successfully: ${result.public_id}`);
    return {
      url: result.secure_url,
      publicId: result.public_id
    };
  } catch (error) {
    console.error(`❌ [Cloudinary Upload] Error uploading base64 image:`, error);
    throw error;
  }
};

// Helper function to get signed URL for authenticated resources
const getAuthenticatedUrl = (publicId, resourceType = 'image') => {
  try {
    const url = cloudinary.url(publicId, {
      resource_type: resourceType,
      type: 'authenticated',
      sign_url: true,
      secure: true
    });
    console.log(`🔐 [Cloudinary] Generated authenticated URL for: ${publicId}`);
    return url;
  } catch (error) {
    console.error('[Cloudinary] Error generating authenticated URL:', error);
    throw error;
  }
};

module.exports = {
  cloudinary,
  upload,
  videoUpload,
  uploadBuffer,
  uploadVerificationVideo,
  deleteImage,
  deleteVideo,
  uploadBase64,
  getAuthenticatedUrl
};
