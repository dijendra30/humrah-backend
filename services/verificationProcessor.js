// services/verificationProcessor.js - Video Processing Pipeline
const axios = require('axios');
const { cloudinary } = require('../config/cloudinary');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const tf = require('@tensorflow/tfjs-node');
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');
const User = require('../models/User');

// Configure face-api with canvas
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// Load face detection models (do this once on server startup)
let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return;
  
  const MODEL_URL = path.join(__dirname, '../models/face-detection');
  
  try {
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_URL);
    modelsLoaded = true;
    console.log('[Verification] Face detection models loaded');
  } catch (error) {
    console.error('[Verification] Error loading models:', error);
    throw error;
  }
}

// =============================================
// MAIN PROCESSING FUNCTION
// =============================================
async function processVerificationVideo(publicId, user, session) {
  console.log(`[Verification] Processing video: ${publicId}`);
  
  let videoPath = null;
  let framesDir = null;
  
  try {
    // Ensure models are loaded
    await loadModels();
    
    // Step 1: Download video from Cloudinary
    videoPath = await downloadVideo(publicId);
    console.log('[Verification] Video downloaded');
    
    // Step 2: Extract frames
    framesDir = await extractFrames(videoPath);
    console.log(`[Verification] Frames extracted to: ${framesDir}`);
    
    // Step 3: Analyze frames for liveness
    const livenessResult = await detectLiveness(framesDir, session.instructions);
    console.log('[Verification] Liveness score:', livenessResult.score);
    
    if (!livenessResult.passed) {
      return {
        decision: 'REJECTED',
        confidence: livenessResult.score,
        livenessScore: livenessResult.score,
        faceMatchScore: null,
        rejectionReason: livenessResult.reason || 'Liveness check failed'
      };
    }
    
    // Step 4: Extract best face
    const faceResult = await extractBestFace(framesDir);
    
    if (!faceResult.success) {
      return {
        decision: 'REJECTED',
        confidence: 0,
        livenessScore: livenessResult.score,
        faceMatchScore: null,
        rejectionReason: faceResult.reason
      };
    }
    
    // Step 5: Generate face embedding
    const embedding = faceResult.embedding;
    
    // Step 6: Compare with profile photo (if exists)
    let faceMatchScore = 1.0; // Default if no profile photo
    
    if (user.profilePhoto) {
      try {
        const profileEmbedding = await getProfilePhotoEmbedding(user.profilePhoto);
        if (profileEmbedding) {
          faceMatchScore = cosineSimilarity(embedding, profileEmbedding);
          console.log('[Verification] Face match score:', faceMatchScore);
        }
      } catch (error) {
        console.error('[Verification] Error matching with profile photo:', error);
        // Continue without profile match
      }
    }
    
    // Step 7: Check for duplicate faces across users
    const duplicateCheck = await checkDuplicateFace(embedding, user._id);
    
    if (duplicateCheck.isDuplicate) {
      return {
        decision: 'REJECTED',
        confidence: 0,
        livenessScore: livenessResult.score,
        faceMatchScore: faceMatchScore,
        rejectionReason: 'This face is already registered to another account'
      };
    }
    
    // Step 8: Make decision
    const decision = makeDecision(livenessResult.score, faceMatchScore);
    
    return {
      decision: decision.result,
      confidence: decision.confidence,
      livenessScore: livenessResult.score,
      faceMatchScore: faceMatchScore,
      faceEmbedding: embedding,
      rejectionReason: decision.reason
    };
    
  } catch (error) {
    console.error('[Verification] Processing error:', error);
    throw error;
  } finally {
    // Cleanup: Delete video and frames
    await cleanup(videoPath, framesDir);
  }
}

// =============================================
// STEP 1: DOWNLOAD VIDEO
// =============================================
async function downloadVideo(publicId) {
  const tempDir = path.join(__dirname, '../temp');
  
  // Ensure temp directory exists
  try {
    await fs.mkdir(tempDir, { recursive: true });
  } catch (error) {
    // Directory already exists
  }
  
  const videoPath = path.join(tempDir, `${publicId.replace(/\//g, '_')}.mp4`);
  
  // Get Cloudinary URL
  const videoUrl = cloudinary.url(publicId, {
    resource_type: 'video',
    type: 'authenticated',
    sign_url: true
  });
  
  // Download video
  const response = await axios({
    method: 'GET',
    url: videoUrl,
    responseType: 'arraybuffer'
  });
  
  await fs.writeFile(videoPath, response.data);
  
  return videoPath;
}

// =============================================
// STEP 2: EXTRACT FRAMES
// =============================================
async function extractFrames(videoPath) {
  const framesDir = videoPath.replace('.mp4', '_frames');
  
  await fs.mkdir(framesDir, { recursive: true });
  
  // Use ffmpeg to extract 1 frame every 300ms (3.33 fps)
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', videoPath,
      '-vf', 'fps=3.33', // ~1 frame every 300ms
      '-q:v', '2',
      path.join(framesDir, 'frame_%03d.jpg')
    ]);
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(framesDir);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    
    ffmpeg.on('error', reject);
  });
}

// =============================================
// STEP 3: LIVENESS DETECTION
// =============================================
async function detectLiveness(framesDir, instructions) {
  const frameFiles = await fs.readdir(framesDir);
  const frames = frameFiles
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map(f => path.join(framesDir, f));
  
  if (frames.length < 5) {
    return {
      passed: false,
      score: 0,
      reason: 'Insufficient frames for analysis'
    };
  }
  
  let blinkDetected = false;
  let headMovementDetected = false;
  let motionScore = 0;
  let photoLikelihood = 0;
  
  try {
    const detections = [];
    
    // Analyze each frame
    for (const framePath of frames) {
      const img = await canvas.loadImage(framePath);
      const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks();
      
      if (detection) {
        detections.push(detection);
      }
    }
    
    if (detections.length < 3) {
      return {
        passed: false,
        score: 0,
        reason: 'Face not consistently detected'
      };
    }
    
    // Check for blinks (eye aspect ratio changes)
    blinkDetected = checkBlinkDetection(detections);
    
    // Check for head movement (yaw angle changes)
    headMovementDetected = checkHeadMovement(detections);
    
    // Check motion consistency (pixel variance)
    motionScore = await checkMotionConsistency(frames);
    
    // Check if it looks like a photo (low variance)
    photoLikelihood = await checkPhotoSpoof(frames);
    
    // Calculate overall liveness score
    let score = 0;
    
    if (blinkDetected) score += 0.3;
    if (headMovementDetected) score += 0.3;
    score += motionScore * 0.3;
    score += (1 - photoLikelihood) * 0.1;
    
    const passed = score >= 0.5 && photoLikelihood < 0.7;
    
    return {
      passed,
      score,
      reason: !passed ? determineLivenessFailureReason(blinkDetected, headMovementDetected, motionScore, photoLikelihood) : null
    };
    
  } catch (error) {
    console.error('[Verification] Liveness detection error:', error);
    return {
      passed: false,
      score: 0,
      reason: 'Error during liveness analysis'
    };
  }
}

// Helper: Check for blinks
function checkBlinkDetection(detections) {
  const EYE_AR_THRESHOLD = 0.2;
  
  for (let i = 1; i < detections.length; i++) {
    const prev = detections[i - 1];
    const curr = detections[i];
    
    const prevEAR = calculateEyeAspectRatio(prev.landmarks);
    const currEAR = calculateEyeAspectRatio(curr.landmarks);
    
    // Blink detected if EAR drops significantly
    if (prevEAR > EYE_AR_THRESHOLD && currEAR < EYE_AR_THRESHOLD) {
      return true;
    }
  }
  
  return false;
}

// Helper: Calculate eye aspect ratio
function calculateEyeAspectRatio(landmarks) {
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  
  const leftEAR = eyeAspectRatio(leftEye);
  const rightEAR = eyeAspectRatio(rightEye);
  
  return (leftEAR + rightEAR) / 2;
}

function eyeAspectRatio(eye) {
  const vertical1 = distance(eye[1], eye[5]);
  const vertical2 = distance(eye[2], eye[4]);
  const horizontal = distance(eye[0], eye[3]);
  
  return (vertical1 + vertical2) / (2 * horizontal);
}

function distance(p1, p2) {
  return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

// Helper: Check head movement
function checkHeadMovement(detections) {
  const angles = detections.map(d => {
    const landmarks = d.landmarks.positions;
    return estimateYawAngle(landmarks);
  });
  
  const minAngle = Math.min(...angles);
  const maxAngle = Math.max(...angles);
  const variation = maxAngle - minAngle;
  
  // Require at least 15 degrees of head rotation
  return variation > 15;
}

// Helper: Estimate yaw angle from landmarks
function estimateYawAngle(landmarks) {
  const nose = landmarks[30];
  const leftEye = landmarks[36];
  const rightEye = landmarks[45];
  
  const eyeCenter = {
    x: (leftEye.x + rightEye.x) / 2,
    y: (leftEye.y + rightEye.y) / 2
  };
  
  const dx = nose.x - eyeCenter.x;
  const eyeDistance = distance(leftEye, rightEye);
  
  // Approximate yaw angle
  return Math.atan2(dx, eyeDistance) * (180 / Math.PI);
}

// Helper: Check motion consistency
async function checkMotionConsistency(frames) {
  // Compare pixel differences between consecutive frames
  let totalDifference = 0;
  let comparisons = 0;
  
  for (let i = 1; i < Math.min(frames.length, 10); i++) {
    const diff = await compareFrames(frames[i - 1], frames[i]);
    totalDifference += diff;
    comparisons++;
  }
  
  const avgDifference = totalDifference / comparisons;
  
  // Normalize to 0-1 scale (more difference = more motion = higher score)
  return Math.min(avgDifference / 50, 1);
}

async function compareFrames(frame1Path, frame2Path) {
  const img1 = await canvas.loadImage(frame1Path);
  const img2 = await canvas.loadImage(frame2Path);
  
  const cnv = canvas.createCanvas(img1.width, img1.height);
  const ctx = cnv.getContext('2d');
  
  ctx.drawImage(img1, 0, 0);
  const data1 = ctx.getImageData(0, 0, img1.width, img1.height).data;
  
  ctx.drawImage(img2, 0, 0);
  const data2 = ctx.getImageData(0, 0, img2.width, img2.height).data;
  
  let diff = 0;
  for (let i = 0; i < data1.length; i += 4) {
    diff += Math.abs(data1[i] - data2[i]); // Red channel only for speed
  }
  
  return diff / (data1.length / 4);
}

// Helper: Check for photo spoof
async function checkPhotoSpoof(frames) {
  // Sample a few frames and check pixel variance
  const sampleFrames = frames.slice(0, Math.min(5, frames.length));
  
  let totalVariance = 0;
  
  for (const framePath of sampleFrames) {
    const img = await canvas.loadImage(framePath);
    const cnv = canvas.createCanvas(img.width, img.height);
    const ctx = cnv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    
    const imageData = ctx.getImageData(0, 0, img.width, img.height).data;
    
    // Calculate variance
    const pixels = [];
    for (let i = 0; i < imageData.length; i += 4) {
      pixels.push(imageData[i]); // Red channel
    }
    
    const mean = pixels.reduce((a, b) => a + b) / pixels.length;
    const variance = pixels.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / pixels.length;
    
    totalVariance += variance;
  }
  
  const avgVariance = totalVariance / sampleFrames.length;
  
  // Low variance suggests static photo
  // Typical variance for real video: > 1000
  // Photo: < 500
  if (avgVariance < 500) {
    return 0.9; // High likelihood of photo
  } else if (avgVariance < 1000) {
    return 0.5; // Medium likelihood
  } else {
    return 0.1; // Low likelihood
  }
}

function determineLivenessFailureReason(blinkDetected, headMovementDetected, motionScore, photoLikelihood) {
  if (photoLikelihood > 0.7) {
    return 'Video appears to be a static photo';
  }
  if (!blinkDetected && !headMovementDetected) {
    return 'No natural movement detected';
  }
  if (motionScore < 0.2) {
    return 'Insufficient motion in video';
  }
  return 'Liveness verification failed';
}

// =============================================
// STEP 4: EXTRACT BEST FACE
// =============================================
async function extractBestFace(framesDir) {
  const frameFiles = await fs.readdir(framesDir);
  const frames = frameFiles
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map(f => path.join(framesDir, f));
  
  let bestFrame = null;
  let bestScore = -1;
  let bestDetection = null;
  
  for (const framePath of frames) {
    try {
      const img = await canvas.loadImage(framePath);
      const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();
      
      if (!detection) continue;
      
      // Score based on:
      // - Detection confidence
      // - Face size (larger is better)
      // - Face centrality
      const score = scoreFaceDetection(detection, img.width, img.height);
      
      if (score > bestScore) {
        bestScore = score;
        bestFrame = framePath;
        bestDetection = detection;
      }
    } catch (error) {
      console.error('[Verification] Error processing frame:', error);
      continue;
    }
  }
  
  if (!bestDetection) {
    return {
      success: false,
      reason: 'No clear face detected in video'
    };
  }
  
  // Check for multiple faces
  const img = await canvas.loadImage(bestFrame);
  const allDetections = await faceapi.detectAllFaces(img);
  
  if (allDetections.length > 1) {
    return {
      success: false,
      reason: 'Multiple faces detected in video'
    };
  }
  
  return {
    success: true,
    embedding: Array.from(bestDetection.descriptor),
    confidence: bestScore
  };
}

function scoreFaceDetection(detection, imageWidth, imageHeight) {
  const box = detection.detection.box;
  
  // Face size score (0-1)
  const faceArea = box.width * box.height;
  const imageArea = imageWidth * imageHeight;
  const sizeScore = Math.min(faceArea / imageArea * 10, 1);
  
  // Centrality score (0-1)
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const imageCenterX = imageWidth / 2;
  const imageCenterY = imageHeight / 2;
  
  const distanceFromCenter = Math.sqrt(
    Math.pow(centerX - imageCenterX, 2) + 
    Math.pow(centerY - imageCenterY, 2)
  );
  const maxDistance = Math.sqrt(
    Math.pow(imageWidth / 2, 2) + 
    Math.pow(imageHeight / 2, 2)
  );
  const centralityScore = 1 - (distanceFromCenter / maxDistance);
  
  // Detection confidence
  const confidenceScore = detection.detection.score;
  
  // Combined score
  return (sizeScore * 0.4 + centralityScore * 0.3 + confidenceScore * 0.3);
}

// =============================================
// STEP 5: GET PROFILE PHOTO EMBEDDING
// =============================================
async function getProfilePhotoEmbedding(profilePhotoUrl) {
  try {
    const img = await canvas.loadImage(profilePhotoUrl);
    const detection = await faceapi
      .detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceDescriptor();
    
    if (!detection) {
      return null;
    }
    
    return Array.from(detection.descriptor);
  } catch (error) {
    console.error('[Verification] Error getting profile photo embedding:', error);
    return null;
  }
}

// =============================================
// STEP 6: COSINE SIMILARITY
// =============================================
function cosineSimilarity(embedding1, embedding2) {
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  
  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    norm1 += embedding1[i] * embedding1[i];
    norm2 += embedding2[i] * embedding2[i];
  }
  
  norm1 = Math.sqrt(norm1);
  norm2 = Math.sqrt(norm2);
  
  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }
  
  return dotProduct / (norm1 * norm2);
}

// =============================================
// STEP 7: CHECK DUPLICATE FACES
// =============================================
async function checkDuplicateFace(embedding, currentUserId) {
  try {
    // Get all verified users with embeddings
    const verifiedUsers = await User.find({
      verified: true,
      verificationEmbedding: { $exists: true, $ne: null },
      _id: { $ne: currentUserId }
    }).select('verificationEmbedding');
    
    for (const user of verifiedUsers) {
      const similarity = cosineSimilarity(embedding, user.verificationEmbedding);
      
      // If similarity is very high (>0.85), it's likely the same person
      if (similarity > 0.85) {
        return {
          isDuplicate: true,
          matchedUserId: user._id,
          similarity
        };
      }
    }
    
    return {
      isDuplicate: false
    };
    
  } catch (error) {
    console.error('[Verification] Error checking duplicates:', error);
    // Don't fail verification on duplicate check error
    return {
      isDuplicate: false
    };
  }
}

// =============================================
// STEP 8: MAKE DECISION
// =============================================
function makeDecision(livenessScore, faceMatchScore) {
  // Calculate overall confidence
  const confidence = (livenessScore * 0.6 + faceMatchScore * 0.4);
  
  // Decision thresholds
  if (confidence >= 0.75 && livenessScore >= 0.5) {
    return {
      result: 'APPROVED',
      confidence,
      reason: null
    };
  } else if (confidence >= 0.55 && confidence < 0.75) {
    return {
      result: 'MANUAL_REVIEW',
      confidence,
      reason: 'Verification requires manual review'
    };
  } else {
    return {
      result: 'REJECTED',
      confidence,
      reason: confidence < 0.55 
        ? 'Verification confidence too low' 
        : 'Liveness check failed'
    };
  }
}

// =============================================
// CLEANUP
// =============================================
async function cleanup(videoPath, framesDir) {
  try {
    if (videoPath) {
      await fs.unlink(videoPath).catch(() => {});
    }
    
    if (framesDir) {
      const files = await fs.readdir(framesDir).catch(() => []);
      for (const file of files) {
        await fs.unlink(path.join(framesDir, file)).catch(() => {});
      }
      await fs.rmdir(framesDir).catch(() => {});
    }
    
    console.log('[Verification] Cleanup completed');
  } catch (error) {
    console.error('[Verification] Cleanup error:', error);
  }
}

module.exports = {
  processVerificationVideo,
  loadModels
};
