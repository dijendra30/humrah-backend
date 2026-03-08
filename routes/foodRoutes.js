// routes/foodRoutes.js
// All Food Discovery endpoints — mount at /api/food in server.js

const express = require('express');
const router  = express.Router();
const multer  = require('multer');

// Reuse existing auth middleware
const { authenticate } = require('../middleware/auth');

const {
  createPost,
  getNearby,
  getFeedCards,
  likePost,
  addComment,
  getComments,
} = require('../controllers/foodController');

// ─── Multer: memory storage (we stream to Cloudinary) ────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'), false);
    }
    cb(null, true);
  },
});

// ─── Routes ──────────────────────────────────────────────────

// Create a new food discovery post
// POST /api/food/create
router.post('/create', authenticate, upload.single('image'), createPost);

// Get food posts near user's city (full paginated list)
// GET /api/food/nearby?city=delhi&page=1
router.get('/nearby', authenticate, getNearby);

// Get 3 cards for the horizontal feed section
// GET /api/food/feed-cards?city=delhi
router.get('/feed-cards', authenticate, getFeedCards);

// Like / unlike a food post
// POST /api/food/like  { postId }
router.post('/like', authenticate, likePost);

// Add a comment
// POST /api/food/comment  { postId, text }
router.post('/comment', authenticate, addComment);

// Get comments for a post
// GET /api/food/comments/:postId?page=1
router.get('/comments/:postId', authenticate, getComments);

// ─── Multer error handler ─────────────────────────────────────
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message === 'Only image files are allowed') {
    return res.status(400).json({ success: false, message: err.message });
  }
  res.status(500).json({ success: false, message: 'Server error' });
});

module.exports = router;
