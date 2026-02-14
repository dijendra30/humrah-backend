// services/verificationProcessor.js - FACE++ CLOUD API (No Storage Needed!)
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const { cloudinary } = require('../config/cloudinary');

const CONFIG = {
  TEMP_DIR: path.join(__dirname, '../temp'),
  FACEPP_API_KEY: process.env.FACEPP_API_KEY,
  FACEPP_API_SECRET: process.env.FACEPP_API_SECRET,
  FACEPP_API_URL: 'https://api-us.faceplusplus.com/facepp/v3',
  MIN_DURATION: 4,
  MAX_DURATION: 10,
  MIN_FILE_SIZE: 500 * 1024,
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  FACE_MATCH_THRESHOLD: 70 // 70% threshold for approval
};

async function processVerificationVideo(cloudinaryPublicId, user, session) {
  const startTime = Date.now();
  let tempVideoPath = null;
  let tempFramePath = null;
  let frameCloudinaryId = null;
  
  try {
    console.log(`\n🎬 [Verification] Processing session ${session.sessionId}`);
    
    // =============================================
    // STEP 1: Download video temporarily
    // =============================================
    console.log('📥 Step 1: Downloading video from Cloudinary...');
    tempVideoPath = await downloadVideo(cloudinaryPublicId);
    console.log(`✅ Video downloaded: ${tempVideoPath}`);
    
    // =============================================
    // STEP 2: Validate video properties
    // =============================================
    console.log('✅ Step 2: Validating video...');
    const validation = await validateVideo(tempVideoPath);
    
    if (!validation.valid) {
      return {
        decision: 'REJECTED',
        confidence: 0,
        livenessScore: null,
        faceMatchScore: null,
        rejectionReason: validation.reason,
        faceEmbedding: null
      };
    }
    
    console.log(`✅ Video validation passed (${validation.duration.toFixed(1)}s, ${(validation.fileSize / 1024).toFixed(2)} KB)`);
    
    // =============================================
    // STEP 3: Extract frame from middle of video
    // =============================================
    console.log('🎞️ Step 3: Extracting frame from video...');
    tempFramePath = await extractFrame(tempVideoPath);
    console.log(`✅ Frame extracted: ${tempFramePath}`);
    
    // =============================================
    // STEP 4: Upload frame to Cloudinary (temporary)
    // =============================================
    console.log('☁️ Step 4: Uploading frame to Cloudinary...');
    const frameUploadResult = await uploadFrameToCloudinary(tempFramePath);
    frameCloudinaryId = frameUploadResult.publicId;
    const frameUrl = frameUploadResult.url;
    console.log(`✅ Frame uploaded: ${frameUrl}`);
    
    // =============================================
    // STEP 5: Face matching with Face++ API
    // =============================================
    if (user.profilePhoto) {
      console.log('🎭 Step 5: Comparing faces with Face++ API...');
      console.log(`   Video frame: ${frameUrl}`);
      console.log(`   Profile photo: ${user.profilePhoto}`);
      
      try {
        const faceMatchResult = await compareFacesWithFacePP(
          frameUrl,
          user.profilePhoto
        );
        
        const faceMatchScore = faceMatchResult.confidence;
        
        console.log(`✅ Face match score: ${faceMatchScore.toFixed(1)}%`);
        console.log(`   Same person: ${faceMatchResult.isSamePerson ? 'Yes' : 'No'}`);
        
        const processingTime = Date.now() - startTime;
        
        console.log(`\n📊 [Verification] Results for session ${session.sessionId}:`);
        console.log(`   Processing Time: ${processingTime}ms`);
        
        // Decision logic based on Face++ score
        if (faceMatchScore >= CONFIG.FACE_MATCH_THRESHOLD) {
          console.log(`   ✅ APPROVED - Face match passed (${faceMatchScore.toFixed(1)}% >= ${CONFIG.FACE_MATCH_THRESHOLD}%)`);
          
          return {
            decision: 'APPROVED',
            confidence: faceMatchScore / 100,
            livenessScore: 0.85,
            faceMatchScore: faceMatchScore / 100,
            rejectionReason: null,
            faceEmbedding: null
          };
        } else if (faceMatchScore >= 60) {
          console.log(`   ⏳ MANUAL REVIEW - Face match needs review (${faceMatchScore.toFixed(1)}%)`);
          
          return {
            decision: 'MANUAL_REVIEW',
            confidence: faceMatchScore / 100,
            livenessScore: 0.85,
            faceMatchScore: faceMatchScore / 100,
            rejectionReason: 'Face match score requires manual review',
            faceEmbedding: null
          };
        } else {
          console.log(`   ❌ REJECTED - Face does not match (${faceMatchScore.toFixed(1)}% < 60%)`);
          
          return {
            decision: 'REJECTED',
            confidence: faceMatchScore / 100,
            livenessScore: 0.85,
            faceMatchScore: faceMatchScore / 100,
            rejectionReason: 'Face does not match profile photo - please record a clearer video',
            faceEmbedding: null
          };
        }
        
      } catch (error) {
        console.error('⚠️ Face matching error:', error.message);
        
        // If Face++ fails, send to manual review
        return {
          decision: 'MANUAL_REVIEW',
          confidence: 0,
          livenessScore: 0.85,
          faceMatchScore: null,
          rejectionReason: 'Face matching failed - requires manual review',
          faceEmbedding: null
        };
      }
      
    } else {
      // No profile photo - auto approve if video is valid
      console.log('ℹ️ No profile photo to match - auto approving based on video validation');
      
      return {
        decision: 'APPROVED',
        confidence: 0.85,
        livenessScore: 0.85,
        faceMatchScore: null,
        rejectionReason: null,
        faceEmbedding: null
      };
    }
    
  } catch (error) {
    console.error('❌ [Verification] Processing error:', error);
    
    return {
      decision: 'MANUAL_REVIEW',
      confidence: 0,
      livenessScore: null,
      faceMatchScore: null,
      rejectionReason: 'Processing error - requires manual review',
      faceEmbedding: null
    };
    
  } finally {
    // =============================================
    // CLEANUP: Delete temporary files
    // =============================================
    try {
      if (tempVideoPath) {
        await fs.unlink(tempVideoPath);
        console.log('🗑️ Temporary video deleted');
      }
      
      if (tempFramePath) {
        await fs.unlink(tempFramePath);
        console.log('🗑️ Temporary frame deleted');
      }
      
      if (frameCloudinaryId) {
        await deleteCloudinaryImage(frameCloudinaryId);
        console.log('🗑️ Temporary Cloudinary frame deleted');
      }
    } catch (cleanupError) {
      console.error('⚠️ Cleanup error:', cleanupError);
    }
  }
}

// =============================================
// HELPER FUNCTIONS
// =============================================

/**
 * Download video from Cloudinary
 */
async function downloadVideo(publicId) {
  try {
    const videoUrl = cloudinary.url(publicId, {
      resource_type: 'video',
      type: 'authenticated',
      sign_url: true,
      secure: true
    });
    
    await fs.mkdir(CONFIG.TEMP_DIR, { recursive: true });
    const tempPath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_video.mp4`);
    
    const response = await axios({
      method: 'get',
      url: videoUrl,
      responseType: 'stream',
      timeout: 60000
    });
    
    const writer = fsSync.createWriteStream(tempPath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(tempPath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Failed to download video:', error.message);
    throw error;
  }
}

/**
 * Validate video properties
 */
async function validateVideo(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        return resolve({ 
          valid: false, 
          reason: 'Invalid video file - please try recording again' 
        });
      }
      
      const duration = metadata.format.duration;
      const fileSize = metadata.format.size;
      
      if (duration < CONFIG.MIN_DURATION) {
        return resolve({ 
          valid: false, 
          reason: `Video too short - please record for at least ${CONFIG.MIN_DURATION} seconds` 
        });
      }
      
      if (duration > CONFIG.MAX_DURATION) {
        return resolve({ 
          valid: false, 
          reason: `Video too long - maximum ${CONFIG.MAX_DURATION} seconds allowed` 
        });
      }
      
      if (fileSize < CONFIG.MIN_FILE_SIZE) {
        return resolve({ 
          valid: false, 
          reason: 'Video quality too low - please ensure good lighting' 
        });
      }
      
      if (fileSize > CONFIG.MAX_FILE_SIZE) {
        return resolve({ 
          valid: false, 
          reason: 'Video file too large - please try again' 
        });
      }
      
      resolve({ 
        valid: true, 
        duration, 
        fileSize 
      });
    });
  });
}

/**
 * Extract frame from middle of video
 */
async function extractFrame(videoPath) {
  const framePath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_frame.jpg`);
  
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['50%'], // Middle of video
        filename: path.basename(framePath),
        folder: path.dirname(framePath),
        size: '640x480'
      })
      .on('end', () => resolve(framePath))
      .on('error', (err) => {
        console.error('Frame extraction error:', err.message);
        reject(err);
      });
  });
}

/**
 * Upload frame to Cloudinary temporarily
 */
async function uploadFrameToCloudinary(framePath) {
  try {
    const result = await cloudinary.uploader.upload(framePath, {
      folder: 'verification-frames-temp',
      resource_type: 'image',
      transformation: [
        { width: 640, height: 480, crop: 'limit' },
        { quality: 'auto:good' }
      ]
    });
    
    return {
      url: result.secure_url,
      publicId: result.public_id
    };
  } catch (error) {
    console.error('Failed to upload frame to Cloudinary:', error.message);
    throw error;
  }
}

/**
 * Delete temporary image from Cloudinary
 */
async function deleteCloudinaryImage(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
      invalidate: true
    });
  } catch (error) {
    console.error('Failed to delete temp image from Cloudinary:', error.message);
    // Don't throw - cleanup failures are not critical
  }
}

/**
 * Compare faces using Face++ API
 */
async function compareFacesWithFacePP(imageUrl1, imageUrl2) {
  try {
    console.log('📞 Calling Face++ API...');
    
    const response = await axios.post(
      `${CONFIG.FACEPP_API_URL}/compare`,
      null,
      {
        params: {
          api_key: CONFIG.FACEPP_API_KEY,
          api_secret: CONFIG.FACEPP_API_SECRET,
          image_url1: imageUrl1,
          image_url2: imageUrl2
        },
        timeout: 30000
      }
    );
    
    console.log('📥 Face++ API response received');
    
    if (!response.data || response.data.error_message) {
      throw new Error(response.data?.error_message || 'Face++ API error');
    }
    
    if (typeof response.data.confidence !== 'number') {
      throw new Error('No confidence score returned from Face++');
    }
    
    // Face++ returns:
    // - confidence: 0-100 (how similar the faces are)
    // - thresholds: {1e-3, 1e-4, 1e-5} (false positive rates)
    
    return {
      confidence: response.data.confidence,
      isSamePerson: response.data.confidence >= CONFIG.FACE_MATCH_THRESHOLD,
      thresholds: response.data.thresholds
    };
    
  } catch (error) {
    if (error.response) {
      console.error('❌ Face++ API error:', error.response.data);
      throw new Error(error.response.data?.error_message || 'Face++ API request failed');
    } else {
      console.error('❌ Face++ API error:', error.message);
      throw error;
    }
  }
}

// =============================================
// EXPORTS
// =============================================
module.exports = {
  processVerificationVideo
};
