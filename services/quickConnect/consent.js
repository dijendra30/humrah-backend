// services/quickConnect/consent.js
// -----------------------------------------------------------------------------
// Quick Connect consent withdrawal (DELETE /api/quick-connect/consent).
//
// Withdrawing is always possible, also while Quick Connect is switched off, and takes effect
// at once, server-side:
//   1. every consent record of the user is deleted, so every later eligibility check fails
//      with CONSENT_REQUIRED until they accept again (no search, match, invitation or TURN);
//   2. their search is removed, their open proposal or call is ended (the other person sees
//      an ordinary end: 'hangup' for a call, 'cancelled' for a proposal) and both holds and
//      the capacity slot are released;
//   3. "Notify me", the Smart Discovery opt-in and any open invitation (sent or received)
//      are removed.
// Reports already filed are kept (they belong to the moderation process, not to consent).
// -----------------------------------------------------------------------------
'use strict';

const QuickConnectConsent = require('../../models/QuickConnectConsent');
const QuickConnectSession = require('../../models/QuickConnectSession');
const QuickConnectPreference = require('../../models/QuickConnectPreference');
const matching = require('./matching');
const lifecycle = require('./lifecycle');
const waitlist = require('./waitlist');
const discovery = require('./discovery');
const notify = require('./notify');

async function withdraw(userId) {
  const removed = (await QuickConnectConsent.deleteMany({ userId })).deletedCount;

  const search = await matching.cancelSearch(userId);
  if (search.cancelled) notify.toUser(userId, 'qc_search_ended', { reason: 'not_eligible' });

  const open = await QuickConnectSession.find({ participants: userId, status: { $in: QuickConnectSession.ACTIVE_STATUSES } })
    .select('_id status').lean();
  let ended = 0;
  for (const s of open) {
    const reason = s.status === 'PROPOSED' ? 'cancelled' : 'hangup';
    if ((await lifecycle.finishSession(s._id, reason, { endedBy: userId })).ended) ended++;
  }

  await waitlist.leave(userId);
  await discovery.cancelForInviter(userId);
  await discovery.cancelForRecipient(userId, { notifyRecipient: true });   // before the token is deleted
  await QuickConnectPreference.deleteOne({ _id: userId });
  return { ok: true, withdrawn: removed > 0, ended };
}

module.exports = { withdraw };
