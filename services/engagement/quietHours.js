// services/engagement/quietHours.js
// -----------------------------------------------------------------------------
// Quiet hours. Pure functions.
//
// Two windows apply, and a notification is sent only outside BOTH:
//   1. the user's own: notifications.quietHoursEnabled / quietHoursStart / quietHoursEnd
//      (stored by Android Notification Settings; the server never enforced them before);
//   2. the system window: ENGAGEMENT_QUIET_START..END (default 22:00–08:00, the same night
//      window the Room recruit pushes use), switchable with ENGAGEMENT_QUIET_HOURS_ENABLED.
//
// Time zone: the User model has no time-zone field. Every existing daily rule in this
// backend (Surprise Activity, Movie, letters, analytics) uses Asia/Kolkata, so that is
// the default (ENGAGEMENT_DEFAULT_TIMEZONE can name another IANA zone). If a user ever
// carries a valid `timezone`, it is used instead; an invalid one falls back to the default.
//
// Windows are [start, end): at exactly the end minute sending is allowed again.
// start === end means an empty window (nothing is quiet), not "all day".
// -----------------------------------------------------------------------------
'use strict';

const { HHMM, isValidTimeZone } = require('../../config/engagementNotificationConfig');

const MIN = 60 * 1000;
const DAY_MIN = 24 * 60;
const USER_DEFAULT = Object.freeze({ start: '23:00', end: '07:00' }); // User schema defaults

function toMinutes(hhmm) {
  if (typeof hhmm !== 'string' || !HHMM.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const fmtCache = new Map();
function localMinutes(date, timeZone) {
  let fmt = fmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmtCache.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(date);
  const h = Number(parts.find(p => p.type === 'hour').value) % 24;
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

function inWindow(mins, w) {
  if (w.start === w.end) return false;
  return w.start < w.end ? (mins >= w.start && mins < w.end) : (mins >= w.start || mins < w.end);
}

/** The quiet windows that apply to this user, as minute ranges, plus the zone used. */
function windowsFor(user, cfg) {
  const windows = [];
  if (cfg.systemQuietEnabled) {
    windows.push({ source: 'SYSTEM', start: toMinutes(cfg.systemQuietStart), end: toMinutes(cfg.systemQuietEnd) });
  }
  const n = user && user.notifications;
  if (n && n.quietHoursEnabled === true) {
    let start = toMinutes(n.quietHoursStart);
    let end = toMinutes(n.quietHoursEnd);
    // A stored value that cannot be read is treated as the schema default, never ignored.
    if (start === null || end === null) { start = toMinutes(USER_DEFAULT.start); end = toMinutes(USER_DEFAULT.end); }
    windows.push({ source: 'USER', start, end });
  }
  const tz = user && isValidTimeZone(user.timezone) ? user.timezone : cfg.defaultTimeZone;
  return { windows: windows.filter(w => w.start !== null && w.end !== null), timeZone: tz };
}

/** Is `now` inside any quiet window for this user? */
function isQuiet(user, now, cfg) {
  const { windows, timeZone } = windowsFor(user, cfg);
  const mins = localMinutes(new Date(now), timeZone);
  return windows.some(w => inWindow(mins, w));
}

/**
 * The earliest time >= now outside every quiet window. Overlapping or chained windows
 * are walked forward; at most a few hops are ever needed.
 */
function nextPermittedTime(user, now, cfg) {
  const { windows, timeZone } = windowsFor(user, cfg);
  let t = new Date(now).getTime();
  for (let hop = 0; hop < 8; hop++) {
    const mins = localMinutes(new Date(t), timeZone);
    const active = windows.filter(w => inWindow(mins, w));
    if (active.length === 0) return new Date(t);
    // Jump to the latest end among the active windows (all measured forward from now).
    const wait = Math.max(...active.map(w => ((w.end - mins) + DAY_MIN) % DAY_MIN || DAY_MIN));
    t = Math.floor(t / MIN) * MIN + wait * MIN;
  }
  return new Date(t);
}

module.exports = { isQuiet, nextPermittedTime, windowsFor, _internal: { toMinutes, localMinutes, inWindow } };
