// utils/photoVerification.js
// -----------------------------------------------------------------------------
// One rule for every route that changes a user's DISPLAYED profile photo or approves a
// photo verification:
//
//   A photo-verification approval applies only to the photo that was reviewed.
//
//   - When the displayed profile photo actually changes, the previous approval no longer
//     applies: the user goes back to `not_submitted` (the same fields the upload routes have
//     always reset) and any verification submission still open for the OLD photo is expired,
//     so it can never be approved for the new one. Nothing is deleted: sessions are kept
//     (status EXPIRED) and the existing review flow is reused for the new submission.
//   - An approval is written only if the photo and the submission state are still exactly
//     what the reviewer acted on (a conditional save), so a photo change racing an approval
//     can never leave a different photo approved. A user who has not submitted anything for
//     the current photo (`not_submitted`) cannot be approved.
//
// Quick Connect needs no change: its eligibility reads photoVerificationStatus === 'approved'.
// -----------------------------------------------------------------------------
'use strict';

const VerificationSession = require('../models/VerificationSession');

/** The fields the profile-photo upload routes reset when the photo changes (unchanged set). */
const RESET_FIELDS = Object.freeze({
  verified: false,
  photoVerificationStatus: 'not_submitted',
  verificationPhotoSubmittedAt: null,
  photoVerifiedAt: null,
  photoVerifiedBy: null,
  photoRejectionReason: null
});

/** Verification submissions that are still waiting for a decision. */
const OPEN_SESSION_STATUSES = ['PENDING', 'PROCESSING', 'MANUAL_REVIEW'];
const PHOTO_CHANGED_REASON = 'Profile photo changed - please verify the new photo';

/** Applies RESET_FIELDS to a loaded user document (caller saves it). */
function applyReset(user) {
  for (const [k, v] of Object.entries(RESET_FIELDS)) user[k] = v;
}

/**
 * Expires the user's open verification submissions (made for the previous photo).
 * Never throws: a failure here must not undo or block the photo change itself; the
 * approval guard below still refuses to approve a user who is `not_submitted`.
 */
async function expireOpenSubmissions(userId) {
  try {
    const r = await VerificationSession.updateMany(
      { userId, status: { $in: OPEN_SESSION_STATUSES } },
      { $set: { status: 'EXPIRED', rejectionReason: PHOTO_CHANGED_REASON } }
    );
    return r.modifiedCount || 0;
  } catch (err) {
    console.error('[photo-verification] expiring open submissions failed:', err && err.name);
    return 0;
  }
}

/**
 * True when `url` is a profile photo stored in Humrah's own image storage: the same
 * Cloudinary account and `humrah/profiles` folder the upload routes write to. Fails closed
 * when the storage account is not configured.
 */
function isHumrahProfilePhotoUrl(url) {
  const cloud = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  if (!cloud || typeof url !== 'string' || url.length > 2048) return false;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  return u.protocol === 'https:' &&
    u.hostname === 'res.cloudinary.com' &&
    u.pathname.startsWith(`/${cloud}/image/upload/`) &&
    u.pathname.includes('/humrah/profiles/');
}

/** Error answer for an approval that no longer matches the user's current photo. */
const PHOTO_CHANGED_RESPONSE = Object.freeze({
  success: false,
  code: 'PHOTO_CHANGED',
  message: 'This user changed their profile photo or has no submission for the current photo. Nothing was approved; they must submit the new photo for verification.'
});

/**
 * Prepares a loaded user for an APPROVAL save: returns false (do not approve) when the user
 * has no submission for the current photo; otherwise pins the save to the photo and the
 * submission state that were just read, so a concurrent photo change makes the save fail
 * with a DocumentNotFoundError instead of approving the new photo.
 */
function guardApproval(user) {
  if (!user || user.photoVerificationStatus === 'not_submitted') return false;
  user.$where = {
    profilePhoto: user.profilePhoto === undefined ? null : user.profilePhoto,
    photoVerificationStatus: user.photoVerificationStatus === undefined ? null : user.photoVerificationStatus
  };
  return true;
}

/**
 * True for the error a guarded save throws when the document no longer matches what was
 * read (photo or submission state changed meanwhile). Mongoose reports this as
 * DocumentNotFoundError, or as VersionError when the save is versioned. Either way
 * nothing was written.
 */
function isGuardMiss(err) {
  return !!err && (err.name === 'DocumentNotFoundError' || err.name === 'VersionError');
}

module.exports = {
  RESET_FIELDS, OPEN_SESSION_STATUSES, PHOTO_CHANGED_REASON, PHOTO_CHANGED_RESPONSE,
  applyReset, expireOpenSubmissions, isHumrahProfilePhotoUrl, guardApproval, isGuardMiss
};
