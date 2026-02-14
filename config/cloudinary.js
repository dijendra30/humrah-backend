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
          reject(error);
        } else {
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
    await cloudinary.uploader.destroy(publicId);
    return true;
  } catch (error) {
    console.error('Error deleting image from Cloudinary:', error);
    return false;
  }
};

// Helper function to delete video from Cloudinary
const deleteVideo = async (publicId) => {
  try {
    console.log(`🗑️ [Cloudinary] Deleting video: ${publicId}`);
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'video',
      invalidate: true
    });
    console.log(`✅ [Cloudinary] Video deleted: ${publicId}`, result);
    return true;
  } catch (error) {
    console.error('[Cloudinary] Error deleting video:', error);
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
    return {
      url: result.secure_url,
      publicId: result.public_id
    };
  } catch (error) {
    console.error('Error uploading base64 image:', error);
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
