// services/roomLifecycleConfig.js
// -----------------------------------------------------------------------------
// The SUGGESTED Room lifetime, in ONE place.
//
// WHY THIS EXISTS: "2 hours" was hard-coded in three files that must agree —
// the expiry job that closes a SUGGESTED Room, the invitation worker's scan
// window, and the invitation dedup TTL. If they ever disagree the failure is
// silent: a Room stays open but is no longer scanned, or a user is re-notified
// about the same Room. They now read the same number.
//
// WHY IT CHANGED FROM 2h: a SUGGESTED Room needs TWO invited users to join
// before it is promoted to ACTIVE (roomController.joinRoom). Two hours from
// creation meant two specific people had to both see a push and act within the
// same two-hour window. Measured outcome: 5 Rooms generated, 0 ever reached
// ACTIVE, all closed with joined=0 or joined=1.
//
// The default is aligned with ROOM_INVITATION_COOLDOWN_HOURS (12h). That is
// deliberate: a user can only receive one Room invitation per cooldown period
// anyway, so a Room that outlives the cooldown would lock its invitees out of
// other Rooms while offering them nothing new.
//
// Everything else in the Room lifecycle is UNCHANGED:
//   ACTIVE/FULL -> INACTIVE @ 24h with no message
//   INACTIVE    -> CLOSED   @ 48h
//   SUGGESTED   -> ACTIVE   at 2 JOINED members (count, not time)
// -----------------------------------------------------------------------------
'use strict';

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const ROOM_LIFECYCLE_CONFIG = {
  // How long a SYSTEM-generated SUGGESTED Room stays open for people to join.
  SUGGESTED_LIFETIME_HOURS: num(process.env.ROOM_SUGGESTED_LIFETIME_HOURS, 12),
};

/** Milliseconds, so no caller re-derives it. */
const suggestedLifetimeMs = () => ROOM_LIFECYCLE_CONFIG.SUGGESTED_LIFETIME_HOURS * 60 * 60 * 1000;

/** Seconds, for Redis TTLs. */
const suggestedLifetimeSeconds = () => ROOM_LIFECYCLE_CONFIG.SUGGESTED_LIFETIME_HOURS * 3600;

/** The cutoff a SUGGESTED Room must be newer than to still be alive. */
const suggestedCutoff = (now = Date.now()) => new Date(now - suggestedLifetimeMs());

module.exports = {
  ROOM_LIFECYCLE_CONFIG,
  suggestedLifetimeMs,
  suggestedLifetimeSeconds,
  suggestedCutoff,
};
