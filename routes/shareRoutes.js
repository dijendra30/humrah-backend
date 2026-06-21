const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const User = require('../models/User');

const generateHtml = (ogTitle, ogDescription, ogImage, ogUrl, deepLink) => {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${ogTitle}</title>
    
    <!-- Open Graph Meta Tags -->
    <meta property="og:title" content="${ogTitle}">
    <meta property="og:description" content="${ogDescription}">
    <meta property="og:image" content="${ogImage}">
    <meta property="og:url" content="${ogUrl}">
    <meta property="og:type" content="website">

    <!-- Twitter Card Meta Tags -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${ogTitle}">
    <meta name="twitter:description" content="${ogDescription}">
    <meta name="twitter:image" content="${ogImage}">

    <style>
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: #0b0f19;
            color: #ffffff;
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
            box-sizing: border-box;
        }
        .card {
            background-color: #161b22;
            border-radius: 20px;
            padding: 24px;
            max-width: 400px;
            width: 100%;
            text-align: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            border: 1px solid #30363d;
        }
        .logo {
            font-size: 28px;
            font-weight: bold;
            color: #c4b5fd;
            margin-bottom: 20px;
            font-style: italic;
            letter-spacing: 1px;
        }
        .preview-image {
            width: 100%;
            height: 300px;
            object-fit: cover;
            border-radius: 12px;
            margin-bottom: 16px;
            background-color: #000;
        }
        .title {
            font-size: 20px;
            font-weight: bold;
            margin-bottom: 8px;
            color: #e6edf3;
        }
        .description {
            font-size: 15px;
            color: #8b949e;
            margin-bottom: 24px;
            line-height: 1.5;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
        .btn {
            display: block;
            width: 100%;
            padding: 14px;
            border-radius: 12px;
            font-size: 16px;
            font-weight: bold;
            text-decoration: none;
            margin-bottom: 12px;
            box-sizing: border-box;
            transition: opacity 0.2s, transform 0.1s;
        }
        .btn:active {
            transform: scale(0.98);
        }
        .btn-primary {
            background: linear-gradient(135deg, #00f5ff 0%, #00ff88 100%);
            color: #000000;
            border: none;
        }
        .btn-secondary {
            background-color: #21262d;
            color: #c9d1d9;
            border: 1px solid #30363d;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">humrah ✨</div>
        ${ogImage ? '<img src="' + ogImage + '" alt="Preview" class="preview-image">' : ''}
        <div class="title">${ogTitle}</div>
        <div class="description">${ogDescription}</div>
        
        <a href="${deepLink}" class="btn btn-primary" onclick="tryOpenApp(event)">Open in Humrah</a>
        <a href="https://play.google.com/store/apps/details?id=com.humrah.app" class="btn btn-secondary">Get Humrah</a>
    </div>

    <script>
        function tryOpenApp(e) {
            if (e) e.preventDefault();
            window.location.href = "${deepLink}";
        }

        // On load, attempt to open the app automatically.
        window.onload = function() {
            setTimeout(function() {
                tryOpenApp();
            }, 500);
        };
    </script>
</body>
</html>`;
};

// GET /post/:postId
router.get('/post/:postId', async (req, res) => {
    try {
        const post = await Post.findById(req.params.postId).populate('userId', 'firstName lastName profilePhotoUrl');
        
        if (!post || !post.isActive) {
            // Render a generic page instead of 404 as requested "Never show a 404."
            return res.send(generateHtml('Humrah Post', 'This post is unavailable or has been removed.', '', 'https://humrah.in', 'humrah://home'));
        }

        const authorName = post.userId ? `${post.userId.firstName} ${post.userId.lastName}`.trim() : 'a Humrah user';
        const ogTitle = `Post by ${authorName} on Humrah`;
        const ogDescription = post.caption || 'Check out this post on Humrah!';
        const ogImage = post.imageUrl || (post.userId ? post.userId.profilePhotoUrl : '');
        const ogUrl = `https://humrah.in/post/${post._id}`;
        const deepLink = `humrah://post/${post._id}`;

        const html = generateHtml(ogTitle, ogDescription, ogImage, ogUrl, deepLink);
        res.send(html);

    } catch (err) {
        console.error('Error fetching post for share:', err);
        // Fallback to generic page
        res.send(generateHtml('Humrah Post', 'Check out Humrah app', '', 'https://humrah.in', 'humrah://home'));
    }
});

// GET /profile/:userId
router.get('/profile/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select('firstName lastName bio profilePhotoUrl isProfileActive');
        
        if (!user || !user.isProfileActive) {
            return res.send(generateHtml('Humrah Profile', 'This profile is unavailable.', '', 'https://humrah.in', 'humrah://home'));
        }

        const name = `${user.firstName} ${user.lastName}`.trim();
        const ogTitle = `${name}'s Profile on Humrah`;
        const ogDescription = user.bio || `Connect with ${name} on Humrah!`;
        const ogImage = user.profilePhotoUrl || '';
        const ogUrl = `https://humrah.in/profile/${user._id}`;
        const deepLink = `humrah://profile/${user._id}`;

        const html = generateHtml(ogTitle, ogDescription, ogImage, ogUrl, deepLink);
        res.send(html);

    } catch (err) {
        console.error('Error fetching profile for share:', err);
        res.send(generateHtml('Humrah Profile', 'Check out Humrah app', '', 'https://humrah.in', 'humrah://home'));
    }
});

module.exports = router;
