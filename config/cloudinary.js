// config/cloudinary.js - Cloudinary Configuration (Updated with Verification Support)
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// (Phase 4.2) The former in-memory `videoUpload` multer instance was removed: it had no consumer,
// and buffering videos in memory is exactly what verification uploads must never do. Video
// uploads use disk storage + streaming (routes/verification.js -> uploadVerificationVideo).

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

// =============================================
// VERIFICATION VIDEOS ARE PRIVATE
// =============================================
// New verification videos are stored with Cloudinary delivery type 'authenticated': Cloudinary
// refuses to deliver them unless the URL is signed with the API secret, which never leaves this
// server. Admins watch them through /api/verification-media/<short-lived token>
// (utils/verificationMedia.js), which streams the video from Cloudinary.
//
// VERIFICATION_VIDEO_DELIVERY_TYPE=upload restores the old public storage. It exists only as an
// explicit, logged rollback switch if the Cloudinary account refuses authenticated uploads.
const VERIFICATION_VIDEO_DELIVERY_TYPES = ['authenticated', 'upload'];

function verificationVideoDeliveryType() {
  const raw = String(process.env.VERIFICATION_VIDEO_DELIVERY_TYPE || 'authenticated').trim().toLowerCase();
  return VERIFICATION_VIDEO_DELIVERY_TYPES.includes(raw) ? raw : 'authenticated';
}

/**
 * The stored reference to a verification video. For 'authenticated' videos this URL is NOT
 * signed, so it gives no access by itself; its path (/video/authenticated/) records how the
 * video is stored. Older sessions store the public secure_url (/video/upload/).
 */
function verificationVideoReferenceUrl(publicId, deliveryType, version) {
  return cloudinary.url(publicId, {
    resource_type: 'video', type: deliveryType, secure: true, format: 'mp4',
    ...(version ? { version } : {})
  });
}

/** Server-side URL the media route fetches from. Signed for authenticated videos; never sent to clients or logged. */
function verificationVideoSourceUrl(publicId, deliveryType) {
  return cloudinary.url(publicId, {
    resource_type: 'video', type: deliveryType, secure: true, format: 'mp4',
    ...(deliveryType === 'authenticated' ? { sign_url: true } : {})
  });
}

// Helper function to upload verification video (private: delivery type 'authenticated')
const uploadVerificationVideo = async (filePath, sessionId) => {
  const deliveryType = verificationVideoDeliveryType();
  return new Promise((resolve, reject) => {
    if (deliveryType !== 'authenticated') {
      console.warn('[Cloudinary] VERIFICATION_VIDEO_DELIVERY_TYPE=upload: verification video stored PUBLICLY (rollback mode)');
    }
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `verification-temp/${sessionId}`,
        resource_type: 'video',
        type: deliveryType,
        format: 'mp4',
        invalidate: true,
        eager: '', // No transformations
        eager_async: false,
        backup: false,
        overwrite: false,
        timeout: 120000 // 2 minute timeout
      },
      (error, result) => {
        if (error) {
          // Category and HTTP code only: the error object can echo upload parameters.
          console.error(`[Cloudinary] verification video upload failed: ${error.name || 'Error'} http=${error.http_code || 'n/a'}`);
          reject(error);
        } else if (!result || !result.public_id || !result.secure_url) {
          resolve({ url: null, publicId: null, deliveryType });
        } else {
          console.log(`[Cloudinary] verification video stored (type=${deliveryType}, bytes=${result.bytes || 'n/a'})`);
          resolve({
            url: verificationVideoReferenceUrl(result.public_id, deliveryType, result.version),
            publicId: result.public_id,
            deliveryType
          });
        }
      }
    );

    const readStream = fs.createReadStream(filePath);
    readStream.on('error', (err) => {
      console.error(`[Cloudinary] could not read the verification video temp file: ${err.code || err.name}`);
      reject(err);
    });
    
    readStream.pipe(uploadStream);
  });
};

// Helper function to delete image from Cloudinary
const deleteImage = async (publicId) => {
  try {
    console.log(`[DELETE IMAGE CALLED]`);
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    console.log(`[CLOUDINARY DELETE RESPONSE]`, result);
    if (result && result.result === 'not found') {
      console.log(`[CLOUDINARY ASSET NOT FOUND]`);
    }
    return true;
  } catch (error) {
    console.error(`❌ [Cloudinary Delete Image] Error deleting image ${publicId}:`, error);
    return false;
  }
};

// Helper function to delete video from Cloudinary.
// `deliveryType` must match how the video was stored ('authenticated' for new verification
// videos, 'upload' for older ones); Cloudinary does not find the asset under the wrong type.
const deleteVideo = async (publicId, deliveryType = 'upload') => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'video',
      type: deliveryType,
      invalidate: true
    });
    console.log(`[Cloudinary] video delete (type=${deliveryType}) result=${result && result.result}`);
    return true;
  } catch (error) {
    console.error(`[Cloudinary] video delete failed (type=${deliveryType}): ${error.name || 'Error'} http=${error.http_code || 'n/a'}`);
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
  uploadBuffer,
  uploadVerificationVideo,
  deleteImage,
  deleteVideo,
  uploadBase64,
  getAuthenticatedUrl,
  verificationVideoDeliveryType,
  verificationVideoReferenceUrl,
  verificationVideoSourceUrl
};
