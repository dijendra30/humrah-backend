// scripts/download-models.js - Auto-download Face-API Models (FIXED URLs)
const https = require('https');
const fs = require('fs');
const path = require('path');

// ✅ CORRECTED URL - Models are in a different location
const MODEL_URL_BASE = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights';
const MODEL_PATH = path.join(__dirname, '../models/face-detection');

const FILES_TO_DOWNLOAD = [
    'ssd_mobilenetv1_model-weights_manifest.json',
    'ssd_mobilenetv1_model-shard1',
    'ssd_mobilenetv1_model-shard2',
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
        
        const request = https.get(url, (response) => {
            // Handle redirects
            if (response.statusCode === 302 || response.statusCode === 301) {
                file.close();
                fs.unlink(dest, () => {});
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            
            if (response.statusCode !== 200) {
                file.close();
                fs.unlink(dest, () => {});
                reject(new Error(`HTTP ${response.statusCode}: ${url}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close(() => {
                    console.log(`✅ Downloaded: ${path.basename(dest)}`);
                    resolve();
                });
            });
            
            file.on('error', (err) => {
                file.close();
                fs.unlink(dest, () => {});
                reject(err);
            });
        });
        
        request.on('error', (err) => {
            file.close();
            fs.unlink(dest, () => {});
            reject(err);
        });
        
        request.setTimeout(30000, () => {
            request.destroy();
            file.close();
            fs.unlink(dest, () => {});
            reject(new Error('Download timeout'));
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
    
    let successCount = 0;
    let skipCount = 0;
    
    try {
        for (const file of FILES_TO_DOWNLOAD) {
            const dest = path.join(MODEL_PATH, file);
            
            // Skip if already exists
            if (fs.existsSync(dest)) {
                console.log(`⏭️  Skipping (already exists): ${file}`);
                skipCount++;
                continue;
            }
            
            const url = `${MODEL_URL_BASE}/${file}`;
            
            try {
                await downloadFile(url, dest);
                successCount++;
            } catch (error) {
                console.error(`❌ Failed to download ${file}: ${error.message}`);
                
                // Try alternative URL
                console.log(`🔄 Trying alternative source...`);
                const altUrl = `https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js/weights/${file}`;
                
                try {
                    await downloadFile(altUrl, dest);
                    successCount++;
                    console.log(`✅ Downloaded from alternative source`);
                } catch (altError) {
                    console.error(`❌ Alternative download also failed: ${altError.message}`);
                    throw new Error(`Could not download ${file} from any source`);
                }
            }
        }
        
        console.log('\n✅ Model download complete!');
        console.log(`   Downloaded: ${successCount} files`);
        console.log(`   Skipped: ${skipCount} files`);
        console.log('\n📊 Final files in directory:');
        
        const files = fs.readdirSync(MODEL_PATH);
        files.forEach(file => {
            const size = fs.statSync(path.join(MODEL_PATH, file)).size;
            console.log(`   - ${file} (${(size / 1024).toFixed(2)} KB)`);
        });
        
        // Verify all required files exist
        const missingFiles = FILES_TO_DOWNLOAD.filter(file => 
            !fs.existsSync(path.join(MODEL_PATH, file))
        );
        
        if (missingFiles.length > 0) {
            console.error('\n⚠️ WARNING: Missing files:', missingFiles);
            throw new Error('Not all required files were downloaded');
        }
        
        console.log('\n🎉 All required models are present!');
        return true;
        
    } catch (error) {
        console.error('\n❌ Error downloading models:', error.message);
        console.error('\n💡 Troubleshooting:');
        console.error('   1. Check your internet connection');
        console.error('   2. Try running: node scripts/download-models.js');
        console.error('   3. Or download manually from:');
        console.error('      https://github.com/justadudewhohacks/face-api.js/tree/master/weights');
        throw error;
    }
}

// Run if called directly
if (require.main === module) {
    downloadModels()
        .then(() => {
            console.log('\n✅ Script completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Script failed:', error.message);
            process.exit(1);
        });
}

module.exports = { downloadModels };
