require('dotenv').config();
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadVerificationVideo = async (buffer, sessionId) => {
  return new Promise((resolve, reject) => {
    console.log(`📤 [Cloudinary] Uploading verification video for session ${sessionId}`);
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `verification-temp/${sessionId}`,
        resource_type: 'video',
        type: 'authenticated', // Private, not public
        invalidate: true,
        timeout: 120000 // 2 minute timeout
      },
      (error, result) => {
        if (error) {
          console.error(`❌ [Cloudinary] Upload failed:`, error);
          reject(error);
        } else {
          console.log(`[CLOUDINARY VIDEO UPLOAD RESPONSE]`, result);
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

const fs = require('fs');
(async () => {
  try {
    console.log("Reading sample.mp4...");
    const buffer = fs.readFileSync('sample.mp4');
    console.log("Uploading...");
    const res = await uploadVerificationVideo(buffer, "test_session_123");
    console.log("Success:", res);
  } catch (err) {
    console.error("Failed:", err);
  }
  process.exit(0);
})();
