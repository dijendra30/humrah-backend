const express = require('express');
const router = express.Router();
const Post = require('../models/Post');

// 1. assetlinks.json
router.get('/.well-known/assetlinks.json', (req, res) => {
    res.json([
        {
            "relation": ["delegate_permission/common.handle_all_urls"],
            "target": {
                "namespace": "android_app",
                "package_name": "com.humrah.app",
                "sha256_cert_fingerprints": [
                    "44:39:FA:B7:59:5A:B2:A4:C5:04:15:05:B1:B6:81:53:24:9F:2F:19:B2:A0:AA:21:30:D7:F6:AB:EB:46:42:85"
                ]
            }
        }
    ]);
});

// Helper for HTML escaping to prevent XSS
const escapeHtml = (unsafe) => {
    if (!unsafe) return '';
    return unsafe
         .toString()
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
};

// 2. /post/:postId
router.get('/post/:postId', async (req, res) => {
    try {
        const post = await Post.findById(req.params.postId).populate('userId', 'firstName lastName');
        
        if (!post) {
            return res.redirect('https://play.google.com/store/apps/details?id=com.humrah.app');
        }

        const authorName = post.userId ? `${post.userId.firstName} ${post.userId.lastName}`.trim() : 'Humrah User';
        const escapedAuthorName = escapeHtml(authorName);
        const escapedCaption = escapeHtml(post.caption ? post.caption.substring(0, 200) : 'Check out this post on Humrah!');
        
        let ogImageUrl = post.imageUrl || '';
        if (ogImageUrl.includes('/upload/')) {
            ogImageUrl = ogImageUrl.replace('/upload/', '/upload/w_1200,h_630,c_fill/');
        }
        
        const ogUrl = `https://api.humrah.in/post/${post._id}`;

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapedAuthorName} on Humrah</title>
    
    <meta property="og:title" content="${escapedAuthorName} on Humrah">
    <meta property="og:description" content="${escapedCaption}">
    <meta property="og:image" content="${ogImageUrl}">
    <meta property="og:url" content="${ogUrl}">
    <meta property="og:type" content="article">

    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapedAuthorName} on Humrah">
    <meta name="twitter:description" content="${escapedCaption}">
    <meta name="twitter:image" content="${ogImageUrl}">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #fafafa; color: #333; text-align: center; padding: 20px; }
        .logo { width: 80px; height: 80px; border-radius: 20px; margin-bottom: 20px; background: linear-gradient(135deg, #6C63FF, #f093fb); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px; }
        .preview { max-width: 400px; background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-bottom: 30px; }
        .preview-title { font-weight: bold; margin-bottom: 8px; }
        .preview-caption { color: #666; font-size: 14px; }
        .btn { display: inline-block; padding: 12px 24px; border-radius: 24px; text-decoration: none; font-weight: bold; margin: 8px; transition: opacity 0.2s; }
        .btn-primary { background: #6C63FF; color: white; }
        .btn-secondary { background: #eee; color: #333; }
        .btn:active { opacity: 0.8; }
    </style>
</head>
<body>
    <div class="logo">H</div>
    <div class="preview">
        <div class="preview-title">${escapedAuthorName}'s Post</div>
        <div class="preview-caption">${escapedCaption}</div>
    </div>
    
    <a href="humrah://post/${post._id}" class="btn btn-primary" id="openAppBtn">Open in Humrah</a>
    <a href="https://play.google.com/store/apps/details?id=com.humrah.app" class="btn btn-secondary">Get Humrah</a>

    <script>
        // Attempt deep link immediately
        window.location.href = "humrah://post/${post._id}";
        
        // Setup fallback
        setTimeout(function() {
            // If the app doesn't open, we just stay on this landing page.
            // The user can manually click 'Get Humrah' or try 'Open in Humrah' again.
        }, 1500);
    </script>
</body>
</html>`;

        res.send(html);

    } catch (err) {
        console.error('Error in /post/:postId route:', err);
        res.redirect('https://play.google.com/store/apps/details?id=com.humrah.app');
    }
});

module.exports = router;
