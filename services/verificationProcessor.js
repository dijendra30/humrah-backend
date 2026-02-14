// services/verificationProcessor.js - Video Verification Processing Engine (UPDATED)
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');
const { Canvas, Image, ImageData } = canvas;
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const { cloudinary } = require('../config/cloudinary');

// Patch face-api to use node-canvas
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// =============================================
// CONFIGURATION - ✅ UPDATED FOR BETTER APPROVAL RATES
// =============================================
const CONFIG = {
  MODELS_PATH: path.join(__dirname, '../models/face-detection'),
  TEMP_DIR: path.join(__dirname, '../temp'),
  
  // ✅ More lenient thresholds
  FACE_MATCH_THRESHOLD: parseFloat(process.env.FACE_MATCH_THRESHOLD) || 0.50,  // Lowered from 0.60
  LIVENESS_THRESHOLD: parseFloat(process.env.LIVENESS_THRESHOLD) || 0.50,      // Lowered from 0.70
  
  MIN_FRAMES: 8,                     // Lowered from 10
  MAX_FRAMES: 20,
  FRAME_INTERVAL_MS: 300
};

// =============================================
// INITIALIZE MODELS (Load once at startup)
// =============================================
let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return;
  
  try {
    console.log('📦 Loading face-api models...');
    console.log('📁 Models path:', CONFIG.MODELS_PATH);
    
    // Check if models directory exists
    if (!fsSync.existsSync(CONFIG.MODELS_PATH)) {
      console.log('📁 Creating models directory...');
      fsSync.mkdirSync(CONFIG.MODELS_PATH, { recursive: true });
    }
    
    // Check for required model files
    const requiredFiles = [
      'ssd_mobilenetv1_model-weights_manifest.json',
      'face_landmark_68_model-weights_manifest.json',
      'face_recognition_model-weights_manifest.json'
    ];
    
    const missingFiles = requiredFiles.filter(file => 
      !fsSync.existsSync(path.join(CONFIG.MODELS_PATH, file))
    );
    
    if (missingFiles.length > 0) {
      console.log('⚠️ Missing model files:', missingFiles);
      console.log('📥 Downloading models automatically...');
      
      try {
        const { downloadModels } = require('../scripts/download-models');
        await downloadModels();
        console.log('✅ Models downloaded successfully!');
      } catch (downloadError) {
        console.error('❌ Failed to download models:', downloadError.message);
        console.error('💡 Please run manually: node scripts/download-models.js');
        throw new Error('Models not available and auto-download failed');
      }
    }
    
    // Verify files exist after download
    const stillMissing = requiredFiles.filter(file => 
      !fsSync.existsSync(path.join(CONFIG.MODELS_PATH, file))
    );
    
    if (stillMissing.length > 0) {
      throw new Error(`Models still missing after download: ${stillMissing.join(', ')}`);
    }
    
    // Load models
    console.log('🔄 Loading ssdMobilenetv1...');
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(CONFIG.MODELS_PATH);
    
    console.log('🔄 Loading faceLandmark68Net...');
    await faceapi.nets.faceLandmark68Net.loadFromDisk(CONFIG.MODELS_PATH);
    
    console.log('🔄 Loading faceRecognitionNet...');
    await faceapi.nets.faceRecognitionNet.loadFromDisk(CONFIG.MODELS_PATH);
    
    modelsLoaded = true;
    console.log('✅ Face-api models loaded successfully!');
    
  } catch (error) {
    console.error('❌ Error loading models:', error);
    console.error('⚠️ Verification system will not work until models are loaded');
    console.error('💡 Try running: node scripts/download-models.js');
    throw new Error('Failed to load face recognition models');
  }
}

// Load models on module import
loadModels().catch(err => {
  console.error('❌ Failed to load models on startup:', err.message);
});

// =============================================
// MAIN PROCESSING FUNCTION
// =============================================
async function processVerificationVideo(cloudinaryPublicId, user, session) {
  const startTime = Date.now();
  let tempVideoPath = null;
  let tempFramesDir = null;
  
  try {
    console.log(`\n🎬 [Verification] Processing session ${session.sessionId}`);
    
    if (!modelsLoaded) {
      console.log('⚠️ Models not loaded yet, attempting to load...');
      await loadModels();
    }
    
    // STEP 1: Download video
    console.log('📥 Step 1: Downloading video from Cloudinary...');
    tempVideoPath = await downloadVideo(cloudinaryPublicId);
    console.log(`✅ Video downloaded: ${tempVideoPath}`);
    
    // STEP 2: Extract frames
    console.log('🎞️ Step 2: Extracting frames from video...');
    tempFramesDir = await extractFrames(tempVideoPath);
    const framePaths = await fs.readdir(tempFramesDir);
    console.log(`✅ Extracted ${framePaths.length} frames`);
    
    if (framePaths.length < CONFIG.MIN_FRAMES) {
      throw new Error(`Insufficient frames: ${framePaths.length} < ${CONFIG.MIN_FRAMES}`);
    }
    
    // STEP 3: Liveness Detection
    console.log('👁️ Step 3: Performing liveness detection...');
    const livenessResult = await detectLiveness(tempFramesDir, framePaths);
    console.log(`✅ Liveness score: ${(livenessResult.score * 100).toFixed(1)}%`);
    
    if (!livenessResult.passed) {
      return {
        decision: 'REJECTED',
        confidence: 0,
        livenessScore: livenessResult.score,
        faceMatchScore: null,
        rejectionReason: livenessResult.reason,
        faceEmbedding: null
      };
    }
    
    // STEP 4: Face Detection & Embedding
    console.log('🔍 Step 4: Detecting faces and generating embedding...');
    const faceResult = await extractBestFace(tempFramesDir, framePaths);
    
    if (!faceResult.success) {
      return {
        decision: 'REJECTED',
        confidence: 0,
        livenessScore: livenessResult.score,
        faceMatchScore: null,
        rejectionReason: faceResult.reason,
        faceEmbedding: null
      };
    }
    
    console.log(`✅ Face detected, embedding generated`);
    
    // STEP 5: Face Matching
    console.log('🎭 Step 5: Matching face with profile photo...');
    let faceMatchScore = null;
    
    if (user.profilePhoto) {
      try {
        faceMatchScore = await matchWithProfilePhoto(
          faceResult.embedding,
          user.profilePhoto
        );
        console.log(`✅ Face match score: ${(faceMatchScore * 100).toFixed(1)}%`);
      } catch (error) {
        console.error('⚠️ Face matching failed:', error.message);
      }
    } else {
      console.log('ℹ️ No profile photo to match against');
    }
    
    // STEP 6: Decision Logic
    console.log('⚖️ Step 6: Making decision...');
    const decision = makeDecision(livenessResult.score, faceMatchScore);
    
    const processingTime = Date.now() - startTime;
    
    console.log(`\n📊 [Verification] Results for session ${session.sessionId}:`);
    console.log(`   Decision: ${decision.decision}`);
    console.log(`   Confidence: ${(decision.confidence * 100).toFixed(1)}%`);
    console.log(`   Liveness: ${(livenessResult.score * 100).toFixed(1)}%`);
    console.log(`   Face Match: ${faceMatchScore ? (faceMatchScore * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log(`   Processing Time: ${processingTime}ms`);
    
    return {
      decision: decision.decision,
      confidence: decision.confidence,
      livenessScore: livenessResult.score,
      faceMatchScore: faceMatchScore,
      rejectionReason: decision.rejectionReason,
      faceEmbedding: faceResult.embedding
    };
    
  } catch (error) {
    console.error('❌ [Verification] Processing error:', error);
    
    return {
      decision: 'FAILED',
      confidence: 0,
      livenessScore: null,
      faceMatchScore: null,
      rejectionReason: `Processing error: ${error.message}`,
      faceEmbedding: null
    };
    
  } finally {
    try {
      if (tempVideoPath) {
        await fs.unlink(tempVideoPath);
        console.log('🗑️ Temporary video deleted');
      }
      
      if (tempFramesDir) {
        await fs.rm(tempFramesDir, { recursive: true, force: true });
        console.log('🗑️ Temporary frames deleted');
      }
    } catch (cleanupError) {
      console.error('⚠️ Cleanup error:', cleanupError);
    }
  }
}

// =============================================
// HELPER FUNCTIONS
// =============================================

async function downloadVideo(publicId) {
  try {
    console.log(`📥 [Download] Getting authenticated URL for: ${publicId}`);
    
    const videoUrl = cloudinary.url(publicId, {
      resource_type: 'video',
      type: 'authenticated',
      sign_url: true,
      secure: true
    });
    
    console.log(`🌐 [Download] Downloading from Cloudinary...`);
    
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
      writer.on('finish', () => {
        console.log(`✅ [Download] Video saved to: ${tempPath}`);
        resolve(tempPath);
      });
      writer.on('error', (err) => {
        console.error(`❌ [Download] Write error:`, err);
        reject(err);
      });
    });
  } catch (error) {
    console.error(`❌ [Download] Failed to download video:`, error.message);
    throw error;
  }
}

async function extractFrames(videoPath) {
  const framesDir = path.join(CONFIG.TEMP_DIR, `frames_${Date.now()}`);
  await fs.mkdir(framesDir, { recursive: true });
  
  return new Promise((resolve, reject) => {
    console.log(`🎞️ [Frames] Extracting frames to: ${framesDir}`);
    
    ffmpeg(videoPath)
      .outputOptions([
        `-vf fps=1000/${CONFIG.FRAME_INTERVAL_MS}`,
        `-vframes ${CONFIG.MAX_FRAMES}`
      ])
      .output(path.join(framesDir, 'frame_%03d.jpg'))
      .on('end', () => {
        console.log(`✅ [Frames] Frame extraction complete`);
        resolve(framesDir);
      })
      .on('error', (err) => {
        console.error(`❌ [Frames] Extraction failed:`, err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * ✅ UPDATED: More lenient liveness detection
 */
async function detectLiveness(framesDir, framePaths) {
  const frames = [];
  
  console.log(`👁️ [Liveness] Analyzing ${Math.min(framePaths.length, 15)} frames...`);
  
  for (const framePath of framePaths.slice(0, 15)) {
    const fullPath = path.join(framesDir, framePath);
    const img = await canvas.loadImage(fullPath);
    const detection = await faceapi
      .detectSingleFace(img)
      .withFaceLandmarks();
    
    if (detection) {
      frames.push(detection);
    }
  }
  
  if (frames.length < 3) {  // ✅ Lowered from 5
    return {
      passed: false,
      score: 0,
      reason: 'Insufficient face detections for liveness check'
    };
  }
  
  // Check 1: Blink detection
  const eyeAspectRatios = frames.map(f => calculateEyeAspectRatio(f.landmarks));
  const earVariance = calculateVariance(eyeAspectRatios);
  const blinkDetected = earVariance > 0.005;  // ✅ Lowered from 0.01
  
  // Check 2: Head movement
  const yawAngles = frames.map(f => estimateYawAngle(f.landmarks));
  const yawVariance = calculateVariance(yawAngles);
  const headMovement = yawVariance > 0.02;  // ✅ Lowered from 0.05
  
  // Check 3: Pixel variance
  const firstFramePath = path.join(framesDir, framePaths[0]);
  const pixelVariance = await calculatePixelVariance(firstFramePath);
  const notFlatPhoto = pixelVariance > 300;  // ✅ Lowered from 500
  
  console.log(`   👁️  Blink detected: ${blinkDetected} (variance: ${earVariance.toFixed(4)})`);
  console.log(`   🔄 Head movement: ${headMovement} (variance: ${yawVariance.toFixed(4)})`);
  console.log(`   📷 Not flat photo: ${notFlatPhoto} (variance: ${pixelVariance.toFixed(2)})`);
  
  // ✅ More generous scoring
  let score = 0;
  let checksPassedCount = 0;
  
  if (blinkDetected) { score += 0.35; checksPassedCount++; }
  if (headMovement) { score += 0.35; checksPassedCount++; }
  if (notFlatPhoto) { score += 0.30; checksPassedCount++; }
  
  // ✅ Pass if ANY 2 out of 3 checks pass OR score >= 0.50
  const passed = checksPassedCount >= 2 || score >= CONFIG.LIVENESS_THRESHOLD;
  
  console.log(`   ✅ Liveness checks passed: ${checksPassedCount}/3`);
  console.log(`   📊 Final liveness score: ${(score * 100).toFixed(1)}%`);
  console.log(`   ${passed ? '✅ PASSED' : '❌ FAILED'} liveness detection`);
  
  return {
    passed,
    score,
    reason: passed ? null : 'Failed liveness detection (possible photo/video spoof)'
  };
}

async function extractBestFace(framesDir, framePaths) {
  let bestFace = null;
  let bestQuality = 0;
  
  console.log(`🔍 [Face] Analyzing frames for best face...`);
  
  for (const framePath of framePaths) {
    const fullPath = path.join(framesDir, framePath);
    const img = await canvas.loadImage(fullPath);
    
    const detections = await faceapi
      .detectAllFaces(img)
      .withFaceLandmarks()
      .withFaceDescriptors();
    
    if (detections.length === 0) continue;
    if (detections.length > 1) continue;
    
    const detection = detections[0];
    const quality = detection.detection.score * detection.detection.box.area;
    
    if (quality > bestQuality) {
      bestQuality = quality;
      bestFace = detection;
    }
  }
  
  if (!bestFace) {
    return {
      success: false,
      reason: 'No clear single face detected in video'
    };
  }
  
  console.log(`✅ [Face] Best face found with quality: ${bestQuality.toFixed(2)}`);
  
  return {
    success: true,
    embedding: Array.from(bestFace.descriptor),
    quality: bestQuality
  };
}

async function matchWithProfilePhoto(verificationEmbedding, profilePhotoUrl) {
  console.log(`🎭 [Match] Downloading profile photo...`);
  
  const response = await axios({
    method: 'get',
    url: profilePhotoUrl,
    responseType: 'arraybuffer',
    timeout: 30000
  });
  
  const buffer = Buffer.from(response.data);
  const img = await canvas.loadImage(buffer);
  
  console.log(`🔍 [Match] Detecting face in profile photo...`);
  
  const detection = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();
  
  if (!detection) {
    throw new Error('No face detected in profile photo');
  }
  
  const profileEmbedding = Array.from(detection.descriptor);
  const similarity = calculateCosineSimilarity(verificationEmbedding, profileEmbedding);
  
  console.log(`✅ [Match] Similarity calculated: ${(similarity * 100).toFixed(2)}%`);
  
  return similarity;
}

/**
 * ✅ UPDATED: More lenient decision logic
 */
function makeDecision(livenessScore, faceMatchScore) {
  console.log(`\n⚖️ [Decision] Making final decision...`);
  console.log(`   Liveness Score: ${(livenessScore * 100).toFixed(1)}%`);
  console.log(`   Face Match Score: ${faceMatchScore ? (faceMatchScore * 100).toFixed(1) + '%' : 'N/A'}`);
  
  // CASE 1: No profile photo - only need liveness
  if (faceMatchScore === null) {
    if (livenessScore >= CONFIG.LIVENESS_THRESHOLD) {
      console.log(`   ✅ APPROVED - Liveness passed (${(livenessScore * 100).toFixed(1)}%)`);
      return {
        decision: 'APPROVED',
        confidence: livenessScore,
        rejectionReason: null
      };
    } else {
      console.log(`   ❌ REJECTED - Liveness too low (${(livenessScore * 100).toFixed(1)}% < 50%)`);
      return {
        decision: 'REJECTED',
        confidence: livenessScore,
        rejectionReason: 'Liveness check failed - please record a clearer video'
      };
    }
  }
  
  // CASE 2: Has profile photo - need both liveness AND face match
  const combinedScore = (livenessScore * 0.4) + (faceMatchScore * 0.6);
  
  console.log(`   Combined Score: ${(combinedScore * 100).toFixed(1)}%`);
  
  // ✅ APPROVE: Face match >= 65% AND liveness >= 45%
  if (faceMatchScore >= 0.65 && livenessScore >= 0.45) {
    console.log(`   ✅ APPROVED - Both checks passed`);
    return {
      decision: 'APPROVED',
      confidence: combinedScore,
      rejectionReason: null
    };
  }
  
  // ✅ APPROVE: High face match (>= 70%) even with lower liveness
  else if (faceMatchScore >= 0.70 && livenessScore >= 0.35) {
    console.log(`   ✅ APPROVED - Strong face match compensates for liveness`);
    return {
      decision: 'APPROVED',
      confidence: combinedScore,
      rejectionReason: null
    };
  }
  
  // ✅ MANUAL REVIEW: Moderate scores
  else if (faceMatchScore >= 0.50 && faceMatchScore < 0.65) {
    console.log(`   ⏳ MANUAL REVIEW - Face match in review range`);
    return {
      decision: 'MANUAL_REVIEW',
      confidence: combinedScore,
      rejectionReason: 'Face match score requires manual review'
    };
  }
  
  // ✅ REJECT: Low face match
  else {
    console.log(`   ❌ REJECTED - Face match too low`);
    return {
      decision: 'REJECTED',
      confidence: combinedScore,
      rejectionReason: 'Face does not match profile photo - please record a clearer video'
    };
  }
}

// =============================================
// UTILITY FUNCTIONS
// =============================================

function calculateEyeAspectRatio(landmarks) {
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  
  const leftEAR = eyeAspectRatio(leftEye);
  const rightEAR = eyeAspectRatio(rightEye);
  
  return (leftEAR + rightEAR) / 2;
}

function eyeAspectRatio(eye) {
  const p1 = eye[1];
  const p2 = eye[5];
  const p3 = eye[2];
  const p4 = eye[4];
  const p5 = eye[0];
  const p6 = eye[3];
  
  const vertical1 = distance(p1, p5);
  const vertical2 = distance(p2, p6);
  const horizontal = distance(p3, p4);
  
  return (vertical1 + vertical2) / (2.0 * horizontal);
}

function distance(p1, p2) {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

function estimateYawAngle(landmarks) {
  const nose = landmarks.getNose();
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  
  const noseTip = nose[3];
  const leftEyeCenter = centroid(leftEye);
  const rightEyeCenter = centroid(rightEye);
  
  const eyeDistance = distance(leftEyeCenter, rightEyeCenter);
  const noseOffset = noseTip.x - (leftEyeCenter.x + rightEyeCenter.x) / 2;
  
  return noseOffset / eyeDistance;
}

function centroid(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function calculateVariance(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
  return variance;
}

async function calculatePixelVariance(imagePath) {
  const { data, info } = await sharp(imagePath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const pixels = Array.from(data);
  return calculateVariance(pixels);
}

function calculateCosineSimilarity(vec1, vec2) {
  const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
  const mag1 = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
  const mag2 = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (mag1 * mag2);
}

// =============================================
// EXPORTS
// =============================================
module.exports = {
  processVerificationVideo,
  loadModels
};
