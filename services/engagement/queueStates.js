// services/engagement/queueStates.js
// -----------------------------------------------------------------------------
// The ONLY way an EngagementNotification changes status. Every transition is one
// conditional findOneAndUpdate on { _id, status: from, ...guard }, so it either happens
// exactly once or not at all — two workers can never both move the same document.
// -----------------------------------------------------------------------------
'use strict';

const EngagementNotification = require('../../models/EngagementNotification');

const ALLOWED = Object.freeze({
  PENDING:     ['PROCESSING', 'CANCELLED'],
  PROCESSING:  ['SENT', 'PENDING', 'FAILED', 'DEAD_LETTER', 'CANCELLED'],
  SENT:        [],
  FAILED:      [],
  CANCELLED:   [],
  DEAD_LETTER: [],
});
const TERMINAL = Object.freeze(['SENT', 'FAILED', 'CANCELLED', 'DEAD_LETTER']);

function canTransition(from, to) {
  return Array.isArray(ALLOWED[from]) && ALLOWED[from].includes(to);
}

/**
 * @param {*} id
 * @param {string} from
 * @param {string} to
 * @param {object} [opts] { guard: extra filter, set, inc, push }
 * @returns {Promise<object|null>} the updated document, or null if it was not in `from` (or the guard failed)
 */
async function transition(id, from, to, opts = {}) {
  if (!canTransition(from, to)) throw new Error(`Illegal engagement notification transition ${from} -> ${to}`);
  const update = { $set: { ...(opts.set || {}), status: to } };
  if (opts.inc) update.$inc = opts.inc;
  if (opts.push) update.$push = opts.push;
  return EngagementNotification.findOneAndUpdate(
    { _id: id, status: from, ...(opts.guard || {}) },
    update,
    { new: true }
  ).lean();
}

module.exports = { ALLOWED, TERMINAL, canTransition, transition };
