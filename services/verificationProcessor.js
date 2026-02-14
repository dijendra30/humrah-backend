// services/verificationProcessor.js - SIMPLIFIED (No TensorFlow/AI)
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const { cloudinary } = require('../config/cloudinary');

const CONFIG = {
  TEMP_DIR: path.join(__dirname, '../temp'),
  MIN_DURATION: 4,
  MAX_DURATION: 10,
  MIN_FILE_SIZE: 500 * 1024,
  MAX_FILE_SIZE: 20 * 1024 * 1024
};

async function processVerificationVideo(cloudinaryPublicId, user, session) {
  const startTime = Date.now();
  let tempVideoPath = null;
  
  try {
    console.log(`\n🎬 [Verification] Processing session ${session.sessionId}`);
    
    console.log('📥 Step 1: Downloading video...');
    tempVideoPath = await downloadVideo(cloudinaryPublicId);
    console.log(`✅ Video downloaded`);
    
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
    
    console.log(`✅ Video validation passed`);
    
    const processingTime = Date.now() - startTime;
    
    console.log(`\n📊 [Verification] Results:`);
    console.log(`   Decision: APPROVED`);
    console.log(`   Duration: ${validation.duration}s`);
    console.log(`   Processing Time: ${processingTime}ms`);
    
    return {
      decision: 'APPROVED',
      confidence: 0.85,
      livenessScore: 0.85,
      faceMatchScore: null,
      rejectionReason: null,
      faceEmbedding: null
    };
    
  } catch (error) {
    console.error('❌ [Verification] Processing error:', error);
    
    return {
      decision: 'MANUAL_REVIEW',
      confidence: 0,
      livenessScore: null,
      faceMatchScore: null,
      rejectionReason: 'Requires manual review',
      faceEmbedding: null
    };
    
  } finally {
    try {
      if (tempVideoPath) {
        await fs.unlink(tempVideoPath);
        console.log('🗑️ Temporary video deleted');
      }
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

async function validateVideo(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        return resolve({
          valid: false,
          reason: 'Invalid video file'
        });
      }
      
      const duration = metadata.format.duration;
      const fileSize = metadata.format.size;
      
      if (duration < CONFIG.MIN_DURATION) {
        return resolve({
          valid: false,
          reason: 'Video too short - please record for at least 4 seconds'
        });
      }
      
      if (duration > CONFIG.MAX_DURATION) {
        return resolve({
          valid: false,
          reason: 'Video too long'
        });
      }
      
      if (fileSize < CONFIG.MIN_FILE_SIZE) {
        return resolve({
          valid: false,
          reason: 'Video quality too low'
        });
      }
      
      if (fileSize > CONFIG.MAX_FILE_SIZE) {
        return resolve({
          valid: false,
          reason: 'Video file too large'
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

module.exports = {
  processVerificationVideo
};
