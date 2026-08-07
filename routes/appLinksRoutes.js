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


module.exports = router;
