// services/quickConnect/accountDeletion.js
// -----------------------------------------------------------------------------
// Quick Connect part of account deletion (controllers/deleteAccountController.js, DELETE /api/users/me).
//
// Called as a REQUIRED step before any other data is deleted. It:
//   1. withdraws Quick Connect consent through the normal path (services/quickConnect/consent.js):
//      ends the user's search, proposal or call at once (the other person sees an ordinary end,
//      holds and the capacity slot are released), removes consent records, Notify me and the
//      Smart Discovery preference, and cancels open invitations the user sent or received —
//      withdrawing the other person's invitation notification;
//   2. deletes EVERY invitation that names the user as sender or recipient, whatever its state
//      (pending, accepted, declined, expired, cancelled) — they are not safety records;
//   3. deletes skip/report pair exclusions and Quick Connect report markers that name the user
//      (the SafetyReport itself is anonymized by the controller like every other report);
//   4. checks that nothing of the above is left, and throws if anything is.
// It throws on any failure, so the controller can stop BEFORE the user document is deleted and the
// user can simply try again: every step is idempotent and a retry finishes the job.
//
// Not deleted here: quickconnectsessions (call records shared with the other participant; they
// are removed by their 30-day TTL index) — see the Phase 1 report for the open privacy question.
// Other users' records are never touched except to end a session with them and to cancel an
// invitation addressed to or sent by the deleted user.
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const Consent = require('../../models/QuickConnectConsent');
const Preference = require('../../models/QuickConnectPreference');
const Invite = require('../../models/QuickConnectInvite');
const PairExclusion = require('../../models/QuickConnectPairExclusion');
const QuickConnectReport = require('../../models/QuickConnectReport');
const Waitlist = require('../../models/QuickConnectWaitlist');
const QuickConnectSearch = require('../../models/QuickConnectSearch');
const consent = require('./consent');

async function purgeForDeletedAccount(userId) {
  if (!userId || !mongoose.isValidObjectId(userId)) throw new Error('invalid user id');
  const id = new mongoose.Types.ObjectId(String(userId));

  const withdrawal = await consent.withdraw(id);
  const invitesDeleted = (await Invite.deleteMany({ $or: [{ inviterId: id }, { recipientId: id }] })).deletedCount;
  const exclusionsDeleted = (await PairExclusion.deleteMany({ users: id })).deletedCount;
  const reportMarkersDeleted = (await QuickConnectReport.deleteMany({ reporterId: id })).deletedCount;

  const left = {
    consents: await Consent.countDocuments({ userId: id }),
    preferences: await Preference.countDocuments({ _id: id }),
    invites: await Invite.countDocuments({ $or: [{ inviterId: id }, { recipientId: id }] }),
    waitlist: await Waitlist.countDocuments({ _id: id }),
    search: await QuickConnectSearch.countDocuments({ _id: id })
  };
  if (Object.values(left).some(n => n > 0)) {
    const err = new Error('Quick Connect cleanup incomplete');
    err.code = 'QC_CLEANUP_INCOMPLETE';
    throw err;
  }
  return {
    sessionsEnded: withdrawal.ended,
    consentWithdrawn: withdrawal.withdrawn,
    invitesDeleted,
    exclusionsDeleted,
    reportMarkersDeleted
  };
}

module.exports = { purgeForDeletedAccount };
