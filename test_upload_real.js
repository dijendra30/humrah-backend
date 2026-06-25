require('dotenv').config();
const { uploadVerificationVideo } = require('./config/cloudinary');

const tinyMp4Base64 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhtZGF0AAAA1W1vb3YAAABsbXZoZAAAAAB8JQdIfCUHSAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAcbW9vbgAAABRtZWhkAAAAAHwlB0gAAAAAAAAB2HRyYWsAAABcdGtoZAAAAAD8JQdI/CUHSAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAHg==";

(async () => {
  try {
    const buffer = Buffer.from(tinyMp4Base64, 'base64');
    console.log("Buffer size:", buffer.length);
    console.log("Uploading...");
    const res = await uploadVerificationVideo(buffer, "test_session_123");
    console.log("Success:", res);
  } catch (err) {
    console.error("Failed:", err);
  }
  process.exit(0);
})();
