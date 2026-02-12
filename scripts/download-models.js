const faceapi = require('@vladmandic/face-api');
const path = require('path');
const fs = require('fs');

async function downloadModels() {
  const modelPath = path.join(__dirname, '../models/face-detection');
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(modelPath)) {
    fs.mkdirSync(modelPath, { recursive: true });
  }

  console.log('📥 Downloading face-api models...');
  
  try {
    // Download required models
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);
    
    console.log('✅ Models downloaded successfully!');
  } catch (error) {
    console.error('❌ Error downloading models:', error);
    
    // Download from URL if disk load fails
    const MODEL_URL = 'https://raw.githubusercontent.com/vladmandic/face-api/master/model';
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    
    console.log('✅ Models downloaded from URL!');
  }
}

downloadModels().catch(console.error);
