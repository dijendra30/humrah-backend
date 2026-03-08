// routes/foodRoutes.js
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const {
  createPost,
  getNearby,
  getFeedCards,
  likePost,
  addComment,
  getComments,
} = require('../controllers/foodController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'), false);
    }
    cb(null, true);
  },
});

// NOTE: authenticate + enforceLegalAcceptance are applied in server.js
// DO NOT add authenticate here — it would double-fire and break req.userId

router.post('/create',          upload.single('image'), createPost);
router.get('/nearby',           getNearby);
router.get('/feed-cards',       getFeedCards);
router.post('/like',            likePost);
router.post('/comment',         addComment);
router.get('/comments/:postId', getComments);

router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message === 'Only image files are allowed') {
    return res.status(400).json({ success: false, message: err.message });
  }
  res.status(500).json({ success: false, message: 'Server error' });
});

module.exports = router;
