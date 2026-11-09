// routes/verification.js - Real Identity Verification System (FIXED)
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const photoVerification = require('../utils/photoVerification');
const User = require('../models/User');
const VerificationSession = require('../models/VerificationSession');
const { uploadVerificationVideo, deleteVideo } = require('../config/cloudinary');
const crypto = require('crypto');
const multer = require('multer');
const { notifyVerificationReview } = require('../services/telegramService');

const os = require('os');
const fs = require('fs');
const path = require('path');
const util = require('util');
const unlinkAsync = util.promisify(fs.unlink);

// =============================================
// MULTER SETUP FOR VIDEO UPLOAD
// =============================================
// Disk storage (the video is never held in memory), equivalent to multer.diskStorage with the same
// temp names — plus what multer 1.x lacks: it remembers the file it is writing, so a client that
// disconnects mid-upload does not leave an open write stream and a partial file behind
// (multer only cleans up files it finished writing). See discardTempUploads below.
const TEMP_PREFIX = 'verification_';
const tempVideoStorage = {
  _handleFile(req, file, cb) {
    const filename = `${TEMP_PREFIX}${Date.now()}_${Math.round(Math.random() * 1E9)}.mp4`;
    const destination = os.tmpdir();
    const filePath = path.join(destination, filename);
    const outStream = fs.createWriteStream(filePath);
    (req._verificationTempUploads || (req._verificationTempUploads = [])).push({ path: filePath, stream: outStream });
    file.stream.pipe(outStream);
    outStream.on('error', cb);
    outStream.on('finish', () => cb(null, { destination, filename, path: filePath, size: outStream.bytesWritten }));
  },
  _removeFile(req, file, cb) {
    fs.unlink(file.path, () => cb(null));
  },
};

/** Close and delete every temp file this request started writing (idempotent). */
function discardTempUploads(req) {
  for (const t of req._verificationTempUploads || []) {
    if (t.discarded) continue;
    t.discarded = true;
    const remove = () => fs.unlink(t.path, (err) => {
      if (err && err.code !== 'ENOENT') console.error(`[Cleanup] temp video delete failed: ${err.code || err.name}`);
    });
    if (t.stream && !t.stream.closed) { t.stream.once('close', remove); t.stream.destroy(); } else remove();
  }
}

// Crash safety net: a process killed mid-upload cannot run any cleanup, so temp videos older than
// an hour (no upload lives that long: storage times out after 2 minutes) are swept periodically.
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;
// Asynchronous on purpose: the server's temp folder can hold many files, and this must never
// block the event loop that serves requests and sockets.
async function sweepStaleTempUploads(now = Date.now()) {
  let removed = 0;
  let names = [];
  try { names = await fs.promises.readdir(os.tmpdir()); } catch (_) { return 0; }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith('.mp4')) continue;
    const p = path.join(os.tmpdir(), name);
    try {
      if (now - (await fs.promises.stat(p)).mtimeMs > TEMP_MAX_AGE_MS) { await fs.promises.unlink(p); removed++; }
    } catch (_) { /* vanished or locked: next sweep */ }
  }
  if (removed) console.log(`[Cleanup] removed ${removed} stale verification temp file(s)`);
  return removed;
}
const runSweep = () => { sweepStaleTempUploads().catch(() => {}); };
setTimeout(runSweep, 10 * 1000).unref();
setInterval(runSweep, 30 * 60 * 1000).unref();

const upload = multer({
  storage: tempVideoStorage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      const err = new Error('Only video files are allowed!');
      err.code = 'INVALID_VIDEO_TYPE';
      cb(err, false);
    }
  }
});

// =============================================
// SUBMISSION SAFETY
// =============================================
// A session is claimed (PENDING -> PROCESSING) before its video goes to storage, so two uploads
// for the same session can never both store a video. A claim older than this is a crashed upload
// and may be taken over (the Cloudinary upload itself times out after 2 minutes).
const PROCESSING_STALE_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 10 * 60 * 1000;

/** Short, non-secret form of a session id for logs. */
const shortId = (id) => (typeof id === 'string' && id.length >= 6 ? `${id.slice(0, 6)}…` : 'n/a');

/** Error reply with a stable code. Messages are written for people; internals are never sent. */
const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, code, message, ...extra });

// =============================================
// UPLOAD CONTENT CHECK + STORAGE CONCURRENCY (Phase 4.2)
// =============================================
// The multipart MIME type is only the client's claim. Every recording the app sends is re-encoded
// to MP4 (Media3 Transformer) first, so a real upload starts with an ISO-BMFF box header
// ("ftyp", or a QuickTime top-level box) or — for WebM/Matroska — the EBML magic number.
const ISO_BMFF_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot']);
async function looksLikeVideoFile(filePath) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const head = Buffer.alloc(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    if (bytesRead < 12) return false;
    if (head.readUInt32BE(0) === 0x1A45DFA3) return true;          // EBML (WebM / Matroska)
    return ISO_BMFF_BOXES.has(head.toString('latin1', 4, 8));      // MP4 / MOV / 3GP
  } catch (_) {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// Videos are already streamed disk -> Cloudinary (never held in memory), so memory stays flat;
// this bounds how many 50 MB transfers compete for the server's uplink and disk at once. A
// request that cannot get a slot in time gets a retryable 503 (the app's worker retries 5xx).
const envInt = (name, def, min, max) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
};
const UPLOAD_CONCURRENCY = envInt('VERIFICATION_UPLOAD_CONCURRENCY', 3, 1, 32);
const UPLOAD_QUEUE_MAX = envInt('VERIFICATION_UPLOAD_QUEUE_MAX', 20, 0, 500);
const UPLOAD_QUEUE_WAIT_MS = envInt('VERIFICATION_UPLOAD_QUEUE_WAIT_MS', 60000, 0, 10 * 60000);
let activeUploads = 0;
const uploadWaiters = [];
/** Resolves to a one-shot release function, or null when no slot is free in time. */
function acquireUploadSlot() {
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = uploadWaiters.shift();
      if (next) next.grant(); else activeUploads--;   // a waiter inherits the slot
    };
  };
  if (activeUploads < UPLOAD_CONCURRENCY) { activeUploads++; return Promise.resolve(makeRelease()); }
  if (uploadWaiters.length >= UPLOAD_QUEUE_MAX) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter = {
      grant: () => { clearTimeout(waiter.timer); resolve(makeRelease()); },
      timer: setTimeout(() => {
        const i = uploadWaiters.indexOf(waiter);
        if (i >= 0) uploadWaiters.splice(i, 1);
        resolve(null);
      }, UPLOAD_QUEUE_WAIT_MS),
    };
    uploadWaiters.push(waiter);
  });
}
/** Test hook: current pool state. */
router._uploadPoolState = () => ({ active: activeUploads, waiting: uploadWaiters.length, limit: UPLOAD_CONCURRENCY });
/** Test hook: the crash-leftover sweep. */
router._sweepStaleTempUploads = (now) => sweepStaleTempUploads(now);

// =============================================
// VERIFICATION INSTRUCTIONS POOL
// =============================================
const VERIFICATION_INSTRUCTIONS = [
  'Turn your head slowly to the left',
  'Turn your head slowly to the right',
  'Blink twice',
  'Smile naturally',
  'Look up slightly',
  'Nod your head once'
];

// =============================================
// START VERIFICATION SESSION
// =============================================
// @route   POST /api/verification/start
// @desc    Start a new verification session with randomized instructions
// @access  Private
router.post('/start', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check if user already verified. `verified` also needs a verified email, so an approved
    // photo verification is checked on its own: a new submission would only replace the
    // approval with "pending".
    if (user.verified || user.photoVerificationStatus === 'approved') {
      return fail(res, 400, 'VERIFICATION_ALREADY_APPROVED', 'User is already verified');
    }

    // A submission already waiting for review (the user is "pending") must not get a duplicate.
    // Sessions left in review from before a decision or a photo change do not block: the
    // user's own status is what says a review is open.
    if (user.photoVerificationStatus === 'pending') {
      const inReview = await VerificationSession.exists({ userId: req.userId, status: 'MANUAL_REVIEW' });
      if (inReview) {
        return fail(res, 400, 'VERIFICATION_UNDER_REVIEW', 'Your verification video is already under review');
      }
    }

    // A video still being stored for this user must finish first.
    const uploading = await VerificationSession.exists({
      userId: req.userId,
      status: 'PROCESSING',
      updatedAt: { $gte: new Date(Date.now() - PROCESSING_STALE_MS) }
    });
    if (uploading) {
      return fail(res, 400, 'VERIFICATION_UPLOAD_IN_PROGRESS', 'Your previous verification video is still uploading. Please wait a moment.');
    }

    // An unused session (started, no video yet) is resumed instead of refused. Before, closing
    // the camera or a camera error locked the user out for 10 minutes. The user still has one
    // active session at a time, and the reply has the same shape as a new session.
    const unused = await VerificationSession.findOne({
      userId: req.userId,
      status: 'PENDING',
      cloudinaryPublicId: null,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (unused) {
      unused.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await unused.save();
      console.log(`[Verification] session ${shortId(unused.sessionId)} resumed for user ${req.userId}`);
      return res.json({
        success: true,
        sessionId: unused.sessionId,
        instructions: unused.instructions,
        duration: 6,
        expiresIn: SESSION_TTL_MS / 1000
      });
    }

    // Generate unique session ID
    const sessionId = crypto.randomBytes(16).toString('hex');
    
    // Randomize instructions (pick 3-4 random instructions)
    const shuffled = [...VERIFICATION_INSTRUCTIONS].sort(() => Math.random() - 0.5);
    const selectedInstructions = shuffled.slice(0, Math.floor(Math.random() * 2) + 3); // 3-4 instructions
    
    // Create verification session
    const session = await VerificationSession.create({
      userId: req.userId,
      sessionId,
      instructions: selectedInstructions,
      status: 'PENDING',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
    });
    
    console.log(`[Verification] session ${shortId(sessionId)} created for user ${req.userId}`);
    
    res.json({
      success: true,
      sessionId: session.sessionId,
      instructions: selectedInstructions,
      duration: 6, // 6 seconds max
      expiresIn: 600 // 10 minutes in seconds
    });
    
  } catch (error) {
    console.error(`[Verification] start failed: ${error.name || 'Error'}`);
    fail(res, 500, 'VERIFICATION_SERVER_ERROR', 'Failed to start verification session');
  }
});

// =============================================
// ✅ NEW: UPLOAD VIDEO ENDPOINT
// =============================================
// @route   POST /api/verification/upload-video
// @desc    Upload verification video from Android
// @access  Private
router.post('/upload-video', auth, (req, res, next) => {
  // The connection closed before we answered (app killed, network lost mid-upload): multer 1.x
  // never finishes such a request, so close and delete the partial temp file here.
  res.on('close', () => { if (!res.writableEnded) discardTempUploads(req); });
  upload.single('video')(req, res, (err) => {
    if (err) {
      if (req.file && req.file.path) {
        unlinkAsync(req.file.path).catch(e => console.error(`[Cleanup] temp video delete failed: ${e.code || e.name}`));
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          console.error(`[Upload] file too large for user ${req.userId}`);
          return fail(res, 413, 'VIDEO_TOO_LARGE', 'Verification video is too large. Maximum allowed size is 50 MB.');
        }
        console.error(`[Upload] multer error ${err.code} for user ${req.userId}`);
        return fail(res, 400, 'INVALID_UPLOAD', 'The video upload was not valid. Please record your video again.');
      }
      if (err.code === 'INVALID_VIDEO_TYPE') {
        // Was a 500, which the app retried forever; a non-video can never succeed.
        console.error(`[Upload] non-video file refused for user ${req.userId}`);
        return fail(res, 415, 'INVALID_VIDEO', 'That file is not a video. Please record your verification video again.');
      }
      console.error(`[Upload] upload parsing failed: ${err.name || 'Error'}`);
      return fail(res, 500, 'VERIFICATION_SERVER_ERROR', 'Failed to upload video');
    }
    next();
  });
}, async (req, res) => {
  let claimed = null;            // the session document while this request holds the claim
  let storedVideo = null;        // { publicId, deliveryType } once the video is in storage
  try {
    let { sessionId } = req.body;

    // Sometimes Retrofit sends text parts with extra quotes depending on converter
    if (typeof sessionId === 'string' && sessionId.startsWith('"') && sessionId.endsWith('"')) {
      sessionId = sessionId.replace(/^"|"$/g, '');
    }

    if (!req.file) {
      return fail(res, 400, 'NO_VIDEO', 'No video file provided');
    }
    // The declared type is only the client's claim: check the file itself.
    if (!(await looksLikeVideoFile(req.file.path))) {
      console.error(`[Upload] content is not a video for user ${req.userId}`);
      return fail(res, 415, 'INVALID_VIDEO', 'That file is not a video. Please record your verification video again.');
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    // Verify session exists and belongs to user
    const session = await VerificationSession.findOne({ sessionId, userId: req.userId });
    if (!session) {
      console.log(`[Upload] session ${shortId(sessionId)} not found for user ${req.userId}`);
      return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    const alreadyDone = () => res.json({
      success: true,
      message: 'Video already uploaded successfully. Sent for manual review.',
      sessionId: session.sessionId,
      status: session.status
    });

    // Phase 10: IDEMPOTENCY
    // If Android network timed out after successful backend processing,
    // it will retry. We must return success immediately without re-uploading.
    if (session.status === 'MANUAL_REVIEW' || session.status === 'APPROVED') {
      console.log(`[Upload] idempotent retry for session ${shortId(sessionId)}`);
      return alreadyDone();
    }

    const processingIsStale = session.status === 'PROCESSING' &&
      session.updatedAt && (Date.now() - new Date(session.updatedAt).getTime()) > PROCESSING_STALE_MS;

    if (session.status === 'PROCESSING' && !processingIsStale) {
      // Another request for this session is storing its video right now. Retryable (5xx), so
      // the app tries again and then receives the idempotent success above.
      res.set('Retry-After', '30');
      return fail(res, 503, 'VERIFICATION_UPLOAD_IN_PROGRESS', 'Your verification video is still being uploaded.');
    }

    if (session.status !== 'PENDING' && !processingIsStale) {
      return fail(res, 400, 'SESSION_NOT_PENDING', `Session cannot be processed in state: ${session.status}`);
    }

    // Check if session expired
    if (session.isExpired()) {
      await VerificationSession.updateOne({ _id: session._id, status: session.status }, { $set: { status: 'EXPIRED' } });
      return fail(res, 400, 'SESSION_EXPIRED', 'Session expired. Please start a new verification.');
    }

    // Never let a new submission replace an approval, or duplicate a review already open.
    const user = await User.findById(req.userId).select('photoVerificationStatus');
    if (!user) {
      return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
    }
    if (user.photoVerificationStatus === 'approved') {
      await VerificationSession.updateOne({ _id: session._id, status: session.status },
        { $set: { status: 'EXPIRED', rejectionReason: 'Already verified' } });
      console.log(`[Upload] session ${shortId(sessionId)} closed: user already approved`);
      return res.json({ success: true, message: 'You are already verified.', sessionId: session.sessionId, status: 'APPROVED' });
    }
    if (user.photoVerificationStatus === 'pending') {
      const otherReview = await VerificationSession.exists({ userId: req.userId, status: 'MANUAL_REVIEW', _id: { $ne: session._id } });
      if (otherReview) {
        await VerificationSession.updateOne({ _id: session._id, status: session.status },
          { $set: { status: 'EXPIRED', rejectionReason: 'Duplicate submission' } });
        console.log(`[Upload] session ${shortId(sessionId)} closed: another submission is already in review`);
        return res.json({ success: true, message: 'Your verification video is already under review.', sessionId: session.sessionId, status: 'MANUAL_REVIEW' });
      }
    }

    // Claim the session: only one request can move it to PROCESSING.
    claimed = await VerificationSession.findOneAndUpdate(
      { _id: session._id, status: session.status, updatedAt: session.updatedAt },
      { $set: { status: 'PROCESSING' } },
      { new: true }
    );
    if (!claimed) {
      const now = await VerificationSession.findById(session._id).select('status').lean();
      if (now && (now.status === 'MANUAL_REVIEW' || now.status === 'APPROVED')) {
        session.status = now.status;
        return alreadyDone();
      }
      res.set('Retry-After', '30');
      return fail(res, 503, 'VERIFICATION_UPLOAD_IN_PROGRESS', 'Your verification video is still being uploaded.');
    }

    // Upload video file to Cloudinary (private: delivery type 'authenticated'), within the
    // bounded storage pool. No slot in time: give the claim back and ask the app to retry.
    const releaseSlot = await acquireUploadSlot();
    if (!releaseSlot) {
      await VerificationSession.updateOne({ _id: claimed._id, status: 'PROCESSING' }, { $set: { status: 'PENDING' } })
        .catch(() => {});
      claimed = null;
      console.warn(`[Upload] storage pool busy; session ${shortId(sessionId)} asked to retry`);
      res.set('Retry-After', '30');
      return fail(res, 503, 'VERIFICATION_UPLOAD_BUSY', 'Verification uploads are busy right now. We will retry automatically.');
    }
    let cloudinaryResult;
    try {
      cloudinaryResult = await uploadVerificationVideo(req.file.path, sessionId);
    } finally {
      releaseSlot();
    }

    // Hard Validation: Verify public_id and the stored reference exist
    if (!cloudinaryResult || !cloudinaryResult.publicId || !cloudinaryResult.url) {
      console.error(`[Upload] storage returned no video for session ${shortId(sessionId)}`);
      await VerificationSession.updateOne({ _id: claimed._id, status: 'PROCESSING' }, { $set: { status: 'PENDING' } });
      claimed = null;
      return fail(res, 500, 'VERIFICATION_SERVER_ERROR', 'Failed to upload video');
    }
    storedVideo = { publicId: cloudinaryResult.publicId, deliveryType: cloudinaryResult.deliveryType };

    // Record the video only if this request still holds the claim (a profile-photo change
    // meanwhile expires open submissions; that video must not enter review).
    const saved = await VerificationSession.findOneAndUpdate(
      { _id: claimed._id, status: 'PROCESSING' },
      { $set: { videoUrl: cloudinaryResult.url, cloudinaryPublicId: cloudinaryResult.publicId, status: 'MANUAL_REVIEW' } },
      { new: true }
    );
    claimed = null;
    if (!saved) {
      await deleteVideo(storedVideo.publicId, storedVideo.deliveryType);
      console.log(`[Upload] session ${shortId(sessionId)} changed during upload; video discarded`);
      return fail(res, 400, 'SESSION_NOT_PENDING', 'Session cannot be processed. Please start a new verification.');
    }

    // Synchronize User profile status so Android UI knows it's pending review.
    // Conditional: an approval that landed meanwhile is never turned back into "pending".
    const updatedUser = await User.findOneAndUpdate(
      { _id: req.userId, photoVerificationStatus: { $ne: 'approved' } },
      {
        photoVerificationStatus: 'pending',
        verificationStatus: 'pending'
      },
      { new: true }
    );
    if (!updatedUser) {
      await VerificationSession.updateOne({ _id: saved._id, status: 'MANUAL_REVIEW' },
        { $set: { status: 'EXPIRED', rejectionReason: 'Already verified', videoUrl: null, cloudinaryPublicId: null } });
      await deleteVideo(storedVideo.publicId, storedVideo.deliveryType);
      console.log(`[Upload] session ${shortId(sessionId)} closed: user approved during upload`);
      return res.json({ success: true, message: 'You are already verified.', sessionId: session.sessionId, status: 'APPROVED' });
    }

    console.log(`[Upload] session ${shortId(sessionId)} -> MANUAL_REVIEW for user ${req.userId}`);

    // Notify UI that video was received and is processing
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${req.userId.toString()}`).emit('verification_status_updated', {
        status: 'MANUAL_REVIEW'
      });
    }

    // Notify admin team via Telegram (fire and forget)
    notifyVerificationReview(updatedUser, saved).catch(err =>
        console.error(`[Telegram] verification review notice failed: ${err && err.name}`)
    );

    res.json({
      success: true,
      message: 'Video uploaded successfully. Sent for manual review.',
      sessionId: session.sessionId,
      status: 'MANUAL_REVIEW'
    });

  } catch (error) {
    console.error(`[Upload] failed: ${error.name || 'Error'}${error.http_code ? ` http=${error.http_code}` : ''}`);
    // Release the claim so the app's retry can upload again.
    if (claimed) {
      await VerificationSession.updateOne({ _id: claimed._id, status: 'PROCESSING' }, { $set: { status: 'PENDING' } })
        .catch(() => {});
    }
    // Technical details stay in the server log; the reply never carries them.
    fail(res, 500, 'VERIFICATION_SERVER_ERROR', 'Failed to upload video');
  } finally {
    if (req.file && req.file.path) {
      unlinkAsync(req.file.path).catch(err => {
        console.error(`[Cleanup] temp video delete failed: ${err.code || err.name}`);
      });
    }
  }
});

// =============================================
// CHECK VERIFICATION STATUS
// =============================================
// @route   GET /api/verification/status/:sessionId
// @desc    Check status of verification session
// @access  Private
router.get('/status/:sessionId', auth, async (req, res) => {
  try {
    const session = await VerificationSession.findOne({
      sessionId: req.params.sessionId,
      userId: req.userId
    });
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Verification session not found'
      });
    }
    
    res.json({
      success: true,
      status: session.status,
      result: session.result,
      confidence: session.confidence,
      rejectionReason: session.rejectionReason,
      processedAt: session.processedAt,
      createdAt: session.createdAt
    });
    
  } catch (error) {
    console.error(`[Verification] status check failed: ${error.name || 'Error'}`);
    res.status(500).json({
      success: false,
      message: 'Failed to check verification status'
    });
  }
});

// =============================================
// GET USER VERIFICATION HISTORY (Admin)
// =============================================
router.get('/history/:userId', auth, async (req, res) => {
  try {
    // Check if user is admin
    const requestingUser = await User.findById(req.userId);
    if (!requestingUser || (requestingUser.role !== 'SUPER_ADMIN' && requestingUser.role !== 'SAFETY_ADMIN')) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    const sessions = await VerificationSession.find({
      userId: req.params.userId
    })
    .sort({ createdAt: -1 })
    .select('-faceEmbedding -videoUrl -cloudinaryPublicId') // no storage references in responses
    .limit(20);
    
    res.json({
      success: true,
      sessions
    });
    
  } catch (error) {
    console.error(`[Verification] history failed: ${error.name || 'Error'}`);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// =============================================
// MANUAL REVIEW ENDPOINTS (Admin)
// =============================================

router.get('/admin/pending-reviews', auth, async (req, res) => {
  try {
    const requestingUser = await User.findById(req.userId);
    if (!requestingUser || (requestingUser.role !== 'SUPER_ADMIN' && requestingUser.role !== 'SAFETY_ADMIN')) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    const pendingSessions = await VerificationSession.find({
      status: 'MANUAL_REVIEW'
    })
    .populate('userId', 'firstName lastName email profilePhoto')
    .select('-faceEmbedding -videoUrl -cloudinaryPublicId') // review videos are watched in the admin dashboard
    .sort({ createdAt: -1 })
    .limit(50);
    
    res.json({
      success: true,
      sessions: pendingSessions
    });
    
  } catch (error) {
    console.error(`[Verification] pending reviews failed: ${error.name || 'Error'}`);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.post('/admin/approve/:sessionId', auth, async (req, res) => {
  try {
    const requestingUser = await User.findById(req.userId);
    if (!requestingUser || (requestingUser.role !== 'SUPER_ADMIN' && requestingUser.role !== 'SAFETY_ADMIN')) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    const session = await VerificationSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    const user = await User.findById(session.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Only a submission made for the CURRENT photo can be approved (utils/photoVerification.js):
    // a session expired by a photo change, or a user with nothing submitted, is refused.
    if (session.status === 'EXPIRED' || !photoVerification.guardApproval(user)) {
      return res.status(409).json(photoVerification.PHOTO_CHANGED_RESPONSE);
    }
    
    user.verified = true;
    user.photoVerificationStatus = 'approved';
    user.photoVerifiedAt = new Date();
    user.photoVerifiedBy = req.userId;
    user.verificationEmbedding = session.faceEmbedding;
    user.verifiedAt = new Date();
    user.verificationStatus = 'approved'; // keep the mirror in step, as the dashboard route does
    // Written first and conditionally: if the photo changed meanwhile, nothing is approved.
    try {
      await user.save();
    } catch (e) {
      if (photoVerification.isGuardMiss(e)) return res.status(409).json(photoVerification.PHOTO_CHANGED_RESPONSE);
      throw e;
    }

    session.status = 'APPROVED';
    session.result = 'APPROVED';
    session.reviewedBy = req.userId;
    session.reviewedAt = new Date();
    await session.save();

    // ✅ Emit real-time socket event on admin approval
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${user._id.toString()}`).emit('verification_status_updated', {
        status: 'APPROVED',
        reviewDeadline: null,
        rejectionReason: null
      });
      console.log(`🔔 [Socket] Admin approved emitted to user ${user._id}`);
    }
    
    res.json({
      success: true,
      message: 'Verification approved'
    });
    
  } catch (error) {
    console.error(`[Verification] legacy approve failed: ${error.name || 'Error'}`);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.post('/admin/reject/:sessionId', auth, async (req, res) => {
  try {
    const requestingUser = await User.findById(req.userId);
    if (!requestingUser || (requestingUser.role !== 'SUPER_ADMIN' && requestingUser.role !== 'SAFETY_ADMIN')) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    const { reason } = req.body;
    
    const session = await VerificationSession.findById(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    const user = await User.findById(session.userId);
    const wasInReview = session.status === 'MANUAL_REVIEW';

    session.status = 'REJECTED';
    session.result = 'REJECTED';
    session.rejectionReason = reason || 'Manually rejected by admin';
    session.reviewedBy = req.userId;
    session.reviewedAt = new Date();
    await session.save();

    // This route used to update only the session, leaving the user "pending" for good (the app
    // showed "under review" and blocked resubmission). Rejecting the submission that is under
    // review now records it on the user exactly as the admin dashboard does. A user who is not
    // "pending" (approved, or who changed photo meanwhile) is left unchanged.
    if (user && wasInReview) {
      await User.updateOne(
        { _id: user._id, photoVerificationStatus: 'pending' },
        { $set: {
            photoVerificationStatus: 'rejected',
            verificationStatus: 'rejected',
            photoRejectionReason: session.rejectionReason,
            verified: false
        } }
      );
    }

    // ✅ Emit real-time socket event on admin rejection
    if (user) {
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${user._id.toString()}`).emit('verification_status_updated', {
          status: 'REJECTED',
          reviewDeadline: null,
          rejectionReason: session.rejectionReason
        });
        console.log(`🔔 [Socket] Admin rejected emitted to user ${user._id}`);
      }
    }
    
    res.json({
      success: true,
      message: 'Verification rejected'
    });
    
  } catch (error) {
    console.error(`[Verification] legacy reject failed: ${error.name || 'Error'}`);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// =============================================
// NOTIFICATION HELPERS
// =============================================

async function sendVerificationResultNotification(user, result, reason = null) {
  try {
    if (!user.fcmTokens || user.fcmTokens.length === 0) {
      console.log('ℹ️ No FCM tokens for user, skipping notification');
      return;
    }
    
    const admin = require('firebase-admin');
    
    let title, body;
    
    if (result === 'APPROVED') {
      title = '✅ Verification Approved!';
      body = 'Your identity has been verified. You now have full access to Humrah.';
    } else if (result === 'REJECTED') {
      title = '❌ Verification Failed';
      body = reason || 'Your verification was unsuccessful. Please try again.';
    } else if (result === 'MANUAL_REVIEW') {
      title = '⏳ Verification Under Review';
      body = 'Your verification is being manually reviewed. You will be notified soon.';
    }
    
    const message = {
      notification: { title, body },
      data: {
        type: 'VERIFICATION_RESULT',
        result: result,
        reason: reason || ''
      },
      tokens: user.fcmTokens
    };
    
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`📱 Verification notification sent: ${response.successCount}/${user.fcmTokens.length}`);
    
  } catch (error) {
    console.error('❌ Failed to send verification notification:', error);
  }
}

async function notifyAdminsForManualReview(session, user) {
  try {
    const admins = await User.find({
      role: { $in: ['SAFETY_ADMIN', 'SUPER_ADMIN'] },
      fcmTokens: { $exists: true, $ne: [] }
    });
    
    if (admins.length === 0) {
      console.log('ℹ️ No admins to notify');
      return;
    }
    
    const admin = require('firebase-admin');
    
    for (const adminUser of admins) {
      const message = {
        notification: {
          title: '⚠️ Manual Verification Required',
          body: `${user.firstName} ${user.lastName} needs manual review`
        },
        data: {
          type: 'MANUAL_REVIEW_PENDING',
          sessionId: session.sessionId,
          userId: user._id.toString()
        },
        tokens: adminUser.fcmTokens
      };
      
      await admin.messaging().sendEachForMulticast(message);
    }
    
    console.log(`📱 Notified ${admins.length} admins about manual review`);
    
  } catch (error) {
    console.error('❌ Failed to notify admins:', error);
  }
}

module.exports = router;
