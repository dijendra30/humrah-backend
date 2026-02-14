// scripts/download-models.js
const https = require('https');
const fs = require('fs');
const path = require('path');

const MODEL_URL_BASE = 'https://raw.githubusercontent.com/vladmandic/face-api/master/model';
const MODEL_PATH = path.join(__dirname, '../models/face-detection');

const FILES_TO_DOWNLOAD = [
    'ssd_mobilenetv1_model-weights_manifest.json',
    'ssd_mobilenetv1_model-shard1',
    'face_landmark_68_model-weights_manifest.json',
    'face_landmark_68_model-shard1',
    'face_recognition_model-weights_manifest.json',
    'face_recognition_model-shard1',
    'face_recognition_model-shard2'
];

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        console.log(`📥 Downloading: ${path.basename(dest)}`);
        
        const file = fs.createWriteStream(dest);
        
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                console.log(`✅ Downloaded: ${path.basename(dest)}`);
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

async function downloadModels() {
    console.log('📦 Starting face-api model download...');
    console.log(`📁 Target directory: ${MODEL_PATH}`);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(MODEL_PATH)) {
        console.log('📁 Creating models directory...');
        fs.mkdirSync(MODEL_PATH, { recursive: true });
    }
    
    try {
        for (const file of FILES_TO_DOWNLOAD) {
            const url = `${MODEL_URL_BASE}/${file}`;
            const dest = path.join(MODEL_PATH, file);
            
            // Skip if already exists
            if (fs.existsSync(dest)) {
                console.log(`⏭️  Skipping (already exists): ${file}`);
                continue;
            }
            
            await downloadFile(url, dest);
        }
        
        console.log('\n✅ All models downloaded successfully!');
        console.log('📊 Downloaded files:');
        fs.readdirSync(MODEL_PATH).forEach(file => {
            const size = fs.statSync(path.join(MODEL_PATH, file)).size;
            console.log(`   - ${file} (${(size / 1024).toFixed(2)} KB)`);
        });
        
    } catch (error) {
        console.error('\n❌ Error downloading models:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    downloadModels();
}

module.exports = { downloadModels };
