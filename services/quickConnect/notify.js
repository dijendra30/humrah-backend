// services/quickConnect/notify.js
// -----------------------------------------------------------------------------
// Quick Connect (Phase 5): the one way services push events to a user. Events go only
// to that user's own /quick-connect sockets, through the server-joined room qcu:<userId>
// (sockets/quickConnectSocket.js). No client can join a room, so nothing here can be
// redirected to someone else. Before the namespace exists (or in unit tests) every
// call is a no-op.
// -----------------------------------------------------------------------------
'use strict';

let nsp = null;

const userRoom = userId => `qcu:${String(userId)}`;

function setNamespace(namespace) { nsp = namespace; }

function toUser(userId, event, payload) {
  if (!nsp || !userId) return;
  nsp.to(userRoom(userId)).emit(event, payload);
}

/** Number of this user's connected /quick-connect sockets (0 when none or no namespace). */
async function socketCount(userId) {
  if (!nsp) return 0;
  return (await nsp.in(userRoom(userId)).fetchSockets()).length;
}

module.exports = { setNamespace, toUser, socketCount, userRoom };
