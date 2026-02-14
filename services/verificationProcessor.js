// services/verificationProcessor.js - WITH FACE MATCHING
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { cloudinary } = require('../config/cloudinary');

const CONFIG = {
  TEMP_DIR: path.join(__dirname, '../temp'),
  PYTHON_SCRIPT: path.join(__dirname, '../scripts/face_matcher.py'),
  MIN_DURATION: 4,
  MAX_DURATION: 10,
  MIN_FILE_SIZE: 500 * 1024,
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  FACE_MATCH_THRESHOLD: 0.6
};

async function processVerificationVideo(cloudinaryPublicId, user, session) {
  const startTime = Date.now();
  let tempVideoPath = null;
  let tempFramePath = null;
  let tempProfilePath = null;
  
  try {
    console.log(`\n🎬 [Verification] Processing session ${session.sessionId}`);
    
    // STEP 1: Download video
    console.log('📥 Step 1: Downloading video...');
    tempVideoPath = await downloadVideo(cloudinaryPublicId);
    console.log(`✅ Video downloaded`);
    
    // STEP 2: Validate video
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
    
    console.log(`✅ Video validation passed (${validation.duration}s)`);
    
    // STEP 3: Extract a frame from video
    console.log('🎞️ Step 3: Extracting frame from video...');
    tempFramePath = await extractFrameFromVideo(tempVideoPath);
    console.log(`✅ Frame extracted`);
    
    // STEP 4: Face matching (if profile photo exists)
    let faceMatchScore = null;
    
    if (user.profilePhoto) {
      console.log('🎭 Step 4: Matching face with profile photo...');
      
      try {
        // Download profile photo
        tempProfilePath = await downloadProfilePhoto(user.profilePhoto);
        
        // Run Python face matcher
        const matchResult = await runFaceMatcher(tempFramePath, tempProfilePath);
        
        if (matchResult.success) {
          faceMatchScore = matchResult.similarity;
          console.log(`✅ Face match score: ${(faceMatchScore * 100).toFixed(1)}%`);
          
          // Decision based on face match
          if (faceMatchScore >= CONFIG.FACE_MATCH_THRESHOLD) {
            console.log(`✅ APPROVED - Face match passed`);
            
            return {
              decision: 'APPROVED',
              confidence: faceMatchScore,
              livenessScore: 0.85,
              faceMatchScore: faceMatchScore,
              rejectionReason: null,
              faceEmbedding: null
            };
          } else if (faceMatchScore >= 0.50) {
            console.log(`⏳ MANUAL REVIEW - Face match needs review`);
            
            return {
              decision: 'MANUAL_REVIEW',
              confidence: faceMatchScore,
              livenessScore: 0.85,
              faceMatchScore: faceMatchScore,
              rejectionReason: 'Face match score requires manual review',
              faceEmbedding: null
            };
          } else {
            console.log(`❌ REJECTED - Face does not match`);
            
            return {
              decision: 'REJECTED',
              confidence: faceMatchScore,
              livenessScore: 0.85,
              faceMatchScore: faceMatchScore,
              rejectionReason: 'Face does not match profile photo',
              faceEmbedding: null
            };
          }
        } else {
          console.error(`⚠️ Face matching error: ${matchResult.error}`);
          // If face matching fails, send to manual review
          return {
            decision: 'MANUAL_REVIEW',
            confidence: 0,
            livenessScore: 0.85,
            faceMatchScore: null,
            rejectionReason: 'Face matching failed - requires manual review',
            faceEmbedding: null
          };
        }
      } catch (error) {
        console.error('⚠️ Face matching exception:', error.message);
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
      console.log('ℹ️ No profile photo - auto approving based on video validation');
      
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
    // Cleanup
    try {
      if (tempVideoPath) await fs.unlink(tempVideoPath);
      if (tempFramePath) await fs.unlink(tempFramePath);
      if (tempProfilePath) await fs.unlink(tempProfilePath);
      console.log('🗑️ Temporary files deleted');
    } catch (cleanupError) {
      console.error('⚠️ Cleanup error:', cleanupError);
    }
  }
}

async function downloadVideo(publicId) {
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
}

async function downloadProfilePhoto(photoUrl) {
  const tempPath = path.join(CONFIG.TEMP_DIR, `${Date.now()}_profile.jpg`);
  
  const response = await axios({
    method: 'get',
    url: photoUrl,
    responseType: 'arraybuffer',
    timeout: 30000
  });
  
  await fs.writeFile(tempPath, response.data);
  return tempPath;
}

async function validateVideo(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        return resolve({ valid: false, reason: 'Invalid video file' });
      }
      
      const duration = metadata.format.duration;
      const fileSize = metadata.format.size;
      
      if (duration < CONFIG.MIN_DURATION) {
        return resolve({ valid: false, reason: 'Video too short' });
      }
      
      if (duration > CONFIG.MAX_DURATION) {
        return resolve({ valid: false, reason: 'Video too long' });
      }
      
      if (fileSize < CONFIG.MIN_FILE_SIZE) {
        return resolve({ valid: false, reason: 'Video quality too low' });
      }
      
      if (fileSize > CONFIG.MAX_FILE_SIZE) {
        return resolve({ valid: false, reason: 'Video file too large' });
      }
      
      resolve({ valid: true, duration, fileSize });
    });
  });
}

async function extractFrameFromVideo(videoPath) {
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
      .on('error', reject);
  });
}

async function runFaceMatcher(framePath, profilePath) {
  try {
    const { stdout } = await execAsync(
      `python3 ${CONFIG.PYTHON_SCRIPT} "${framePath}" "${profilePath}"`
    );
    
    return JSON.parse(stdout);
  } catch (error) {
    console.error('Python face matcher error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  processVerificationVideo
};
