// services/appUpdates/appUpdateService.js
// -----------------------------------------------------------------------------
// App Update Management — database work behind routes/appUpdates.js (the app) and
// routes/adminAppUpdates.js (the dashboard). Rules live in appUpdatePolicy.js.
//
// Results are { status, success, ... } objects (the shape routes/adminQuestions.js uses).
// Every admin change is written twice: to the release's own changeLog (always) and to the
// shared AuditLog (actor, action, target, reason, before/after).
// -----------------------------------------------------------------------------
'use strict';

const mongoose = require('mongoose');
const AppRelease = require('../../models/AppRelease');
const AppVersionTelemetry = require('../../models/AppVersionTelemetry');
const AppUpdateEventDaily = require('../../models/AppUpdateEventDaily');
const AuditLog = require('../../models/AuditLog');
const P = require('./appUpdatePolicy');

const PLATFORM = 'ANDROID';
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_MS = 330 * 60 * 1000;
const ACTIVE_WINDOW_DAYS = 30;
const TELEMETRY_REFRESH_MS = 6 * 60 * 60 * 1000;
const CHANGELOG_CAP = 200;

const ok = (body = {}, status = 200) => ({ status, success: true, ...body });
const fail = (status, code, message, extra = {}) => ({ status, success: false, code, message, ...extra });
const isId = id => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id);
const istDay = (t = Date.now()) => new Date(t + IST_MS).toISOString().slice(0, 10);

// ── Live release ──────────────────────────────────────────────────────────────

/**
 * Turns due SCHEDULED releases into the live one. Idempotent and safe to run on every
 * request: only when a scheduled time has passed does anything change. If several are
 * due, the highest versionCode goes live and the others are superseded.
 */
async function activateDueReleases(now = new Date()) {
  const due = await AppRelease.find({ platform: PLATFORM, status: 'SCHEDULED', scheduledAt: { $lte: now } })
    .sort({ versionCode: -1 }).lean();
  if (!due.length) return null;
  const [winner, ...rest] = due;
  const live = await AppRelease.findOne({ platform: PLATFORM, status: 'PUBLISHED' }).lean();
  if (live && live.versionCode >= winner.versionCode) {
    // A newer release went live meanwhile: the scheduled ones would be downgrades.
    await AppRelease.updateMany({ _id: { $in: due.map(d => d._id) }, status: 'SCHEDULED' }, {
      $set: { status: 'SUPERSEDED', supersededAt: now },
      $push: { changeLog: { $each: [{ at: now, action: 'SUPERSEDED', reason: 'A newer release was already live when this one was due.' }], $slice: -CHANGELOG_CAP } },
    });
    return null;
  }
  if (live) {
    await AppRelease.updateOne({ _id: live._id, status: 'PUBLISHED' }, {
      $set: { status: 'SUPERSEDED', supersededAt: now },
      $push: { changeLog: { $each: [{ at: now, action: 'SUPERSEDED', changes: { by: String(winner._id) } }], $slice: -CHANGELOG_CAP } },
    });
  }
  try {
    const activated = await AppRelease.findOneAndUpdate({ _id: winner._id, status: 'SCHEDULED' }, {
      $set: { status: 'PUBLISHED', publishedAt: now },
      $push: { changeLog: { $each: [{ at: now, action: 'PUBLISHED', changes: { scheduled: true } }], $slice: -CHANGELOG_CAP } },
    }, { new: true }).lean();
    if (rest.length) {
      await AppRelease.updateMany({ _id: { $in: rest.map(d => d._id) }, status: 'SCHEDULED' }, {
        $set: { status: 'SUPERSEDED', supersededAt: now },
        $push: { changeLog: { $each: [{ at: now, action: 'SUPERSEDED', changes: { by: String(winner._id) } }], $slice: -CHANGELOG_CAP } },
      });
    }
    return activated;
  } catch (e) {
    if (e && e.code === 11000) return null; // another request activated it first
    throw e;
  }
}

async function liveRelease(now = new Date()) {
  await activateDueReleases(now);
  return AppRelease.findOne({ platform: PLATFORM, status: 'PUBLISHED' }).lean();
}

// ── The app's check ───────────────────────────────────────────────────────────

/** Records what a signed-in user runs; at most one write per user every few hours unless it changed. */
async function recordInstalledVersion(userId, versionCode, versionName, now = new Date()) {
  const existing = await AppVersionTelemetry.findOne({ userId, platform: PLATFORM }).select('versionCode versionName lastSeenAt').lean();
  if (!existing) {
    try {
      await AppVersionTelemetry.create({ userId, platform: PLATFORM, versionCode, versionName, firstSeenAt: now, lastSeenAt: now, history: [{ versionCode, at: now }] });
    } catch (e) { if (!(e && e.code === 11000)) throw e; }
    return;
  }
  const changed = existing.versionCode !== versionCode;
  if (!changed && existing.versionName === versionName && now - new Date(existing.lastSeenAt) < TELEMETRY_REFRESH_MS) return;
  const update = { $set: { versionCode, versionName, lastSeenAt: now } };
  if (changed) update.$push = { history: { $each: [{ versionCode, at: now }], $slice: -AppVersionTelemetry.HISTORY_CAP } };
  await AppVersionTelemetry.updateOne({ _id: existing._id }, update);
}

/**
 * GET /api/app-updates/android. `user` is the signed-in user or null (the check also runs
 * before sign-in). The rollout identity is the user id, else the app's install id.
 */
async function checkForClient({ versionCode, versionName, installId, user }, now = new Date()) {
  const code = P.parseVersionCode(versionCode);
  if (code == null) return fail(400, 'INVALID_VERSION', 'versionCode must be the app’s numeric Android versionCode.');
  const name = versionName == null || versionName === '' ? null : P.parseVersionName(versionName);
  if (versionName != null && versionName !== '' && !name) return fail(400, 'INVALID_VERSION', 'versionName is not valid.');
  const install = typeof installId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(installId) ? installId : null;

  const release = await liveRelease(now);
  const stableId = user ? `u:${user._id}` : install ? `i:${install}` : null;
  const decision = P.decideUpdate({ installedVersionCode: code, release, stableId });
  if (user) {
    try { await recordInstalledVersion(user._id, code, name, now); }
    catch (e) { console.error('[app-updates] telemetry write failed:', e && e.name); }
  }
  return { status: 200, ...P.clientResponse(decision, release) };
}

async function recordEvent({ releaseId, event, updateType }, now = new Date()) {
  if (!isId(releaseId)) return fail(400, 'INVALID_EVENT', 'releaseId is not valid.');
  if (!AppUpdateEventDaily.EVENTS.includes(event)) return fail(400, 'INVALID_EVENT', 'Unknown event.');
  if (!AppUpdateEventDaily.UPDATE_TYPES.includes(updateType)) return fail(400, 'INVALID_EVENT', 'Unknown update type.');
  const release = await AppRelease.findOne({ _id: releaseId, status: { $in: ['PUBLISHED', 'PAUSED', 'SUPERSEDED', 'WITHDRAWN'] } }).select('_id').lean();
  if (!release) return fail(404, 'RELEASE_NOT_FOUND', 'No such release.');
  await AppUpdateEventDaily.updateOne(
    { releaseId: release._id, day: istDay(now.getTime()), event, updateType },
    { $inc: { count: 1 } },
    { upsert: true }
  );
  return ok({}, 202);
}

// ── Admin ─────────────────────────────────────────────────────────────────────

function toAdmin(r) {
  if (!r) return null;
  return {
    id: String(r._id), platform: r.platform,
    versionName: r.versionName, versionCode: r.versionCode, minimumSupportedVersionCode: r.minimumSupportedVersionCode,
    releaseTitle: r.releaseTitle, releaseDescription: r.releaseDescription || '', releaseNotes: r.releaseNotes || [],
    updatePolicy: r.updatePolicy, status: r.status, rolloutPercentage: r.rolloutPercentage, playStoreUrl: r.playStoreUrl,
    reminderCooldownHours: r.reminderCooldownHours, maxReminders: r.maxReminders, allowPostponement: r.allowPostponement,
    scheduledAt: r.scheduledAt, scheduleTimeZone: r.scheduleTimeZone,
    publishedAt: r.publishedAt, pausedAt: r.pausedAt, withdrawnAt: r.withdrawnAt, supersededAt: r.supersededAt,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    changeLog: (r.changeLog || []).slice(-50).reverse().map(c => ({
      at: c.at, action: c.action, byEmail: c.byEmail || null, reason: c.reason || null, changes: c.changes || null,
    })),
  };
}

function readReason(body, required) {
  const reason = body && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (required && (reason.length < 3 || reason.length > 300)) return { error: fail(400, 'REASON_REQUIRED', 'Please give a reason (3–300 characters).') };
  if (reason.length > 300) return { error: fail(400, 'REASON_REQUIRED', 'Please keep the reason under 300 characters.') };
  return { reason: reason || null };
}

async function audit(admin, action, release, { reason = null, before = null, after = null, req = null } = {}) {
  const log = await AuditLog.logAction({
    actorId: admin._id, actorRole: admin.role, actorEmail: admin.email || 'unknown',
    action, targetType: 'APP_RELEASE', targetId: release && release._id,
    reason: reason || undefined,
    details: { platform: PLATFORM, versionName: release && release.versionName, versionCode: release && release.versionCode },
    previousState: before || undefined, newState: after || undefined,
    ipAddress: req ? req.ip : undefined, userAgent: req ? req.get('user-agent') : undefined,
    requestMethod: req ? req.method : undefined, requestPath: req ? req.originalUrl.split('?')[0] : undefined,
  });
  if (!log) console.error('[app-updates-admin] audit write failed:', action);
}

const changeEntry = (admin, action, { reason = null, changes = null } = {}) =>
  ({ at: new Date(), by: admin._id, byEmail: admin.email || null, action, ...(reason ? { reason } : {}), ...(changes ? { changes } : {}) });

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj && obj[k] !== undefined).map(k => [k, obj[k]]));

async function duplicateVersion(versionCode, exceptId = null) {
  const q = { platform: PLATFORM, versionCode, status: { $ne: 'WITHDRAWN' } };
  if (exceptId) q._id = { $ne: exceptId };
  return AppRelease.exists(q);
}

async function listReleases() {
  await activateDueReleases();
  const releases = await AppRelease.find({ platform: PLATFORM }).sort({ createdAt: -1 }).limit(200).lean();
  return ok({ releases: releases.map(toAdmin) });
}

async function getRelease(id) {
  if (!isId(id)) return fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
  await activateDueReleases();
  const r = await AppRelease.findById(id).lean();
  return r ? ok({ release: toAdmin(r) }) : fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
}

const REQUIRED_ON_CREATE = ['versionName', 'versionCode', 'minimumSupportedVersionCode', 'releaseTitle', 'playStoreUrl'];

async function createRelease(admin, body, req) {
  const { values, errors } = P.readReleaseInput(body, { allowed: [...P.EDITABLE_ALWAYS, 'versionName', 'versionCode'] });
  if (errors) return fail(400, 'VALIDATION_FAILED', errors[0].message, { errors });
  const missing = REQUIRED_ON_CREATE.filter(k => values[k] === undefined);
  if (missing.length) return fail(400, 'VALIDATION_FAILED', `Missing: ${missing.join(', ')}.`, { errors: missing.map(field => ({ field, message: 'Required.' })) });
  if (await duplicateVersion(values.versionCode)) {
    return fail(409, 'DUPLICATE_VERSION', `A release with versionCode ${values.versionCode} already exists.`);
  }
  const release = await AppRelease.create({
    ...values, platform: PLATFORM, status: 'DRAFT', createdBy: admin._id, updatedBy: admin._id,
    changeLog: [changeEntry(admin, 'CREATED', { changes: values })],
  });
  await audit(admin, 'APP_RELEASE_CREATED', release, { after: values, req });
  return ok({ release: toAdmin(release.toObject()) }, 201);
}

async function updateRelease(admin, id, body, req) {
  if (!isId(id)) return fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
  const release = await AppRelease.findById(id);
  if (!release) return fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
  let allowed;
  if (['DRAFT', 'SCHEDULED'].includes(release.status)) allowed = [...P.EDITABLE_ALWAYS, 'versionName', 'versionCode'];
  else if (['PUBLISHED', 'PAUSED'].includes(release.status)) allowed = P.EDITABLE_ALWAYS;
  else return fail(409, 'RELEASE_READ_ONLY', `A ${release.status.toLowerCase()} release can no longer be edited.`);

  const src = body && typeof body === 'object' ? body : {};
  const blocked = ['versionName', 'versionCode'].filter(k => src[k] !== undefined && !allowed.includes(k) && src[k] !== release[k]);
  if (blocked.length) return fail(409, 'VERSION_LOCKED', 'The version of a published release cannot change. Create a new release instead.');

  const { values, errors } = P.readReleaseInput(src, { existing: release, allowed });
  if (errors) return fail(400, 'VALIDATION_FAILED', errors[0].message, { errors });
  if (!Object.keys(values).length) return fail(400, 'NOTHING_TO_UPDATE', 'Nothing to change.');
  if (values.versionCode !== undefined && values.versionCode !== release.versionCode && await duplicateVersion(values.versionCode, release._id)) {
    return fail(409, 'DUPLICATE_VERSION', `A release with versionCode ${values.versionCode} already exists.`);
  }
  const before = pick(release.toObject(), Object.keys(values));
  Object.assign(release, values, { updatedBy: admin._id });
  release.changeLog.push(changeEntry(admin, 'UPDATED', { changes: { before, after: values } }));
  if (release.changeLog.length > CHANGELOG_CAP) release.changeLog = release.changeLog.slice(-CHANGELOG_CAP);
  await release.save();
  await audit(admin, 'APP_RELEASE_UPDATED', release, { before, after: values, req });
  return ok({ release: toAdmin(release.toObject()) });
}

async function publishRelease(admin, id, body, req, now = new Date()) {
  if (!isId(id)) return fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
  const release = await AppRelease.findById(id);
  if (!release) return fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
  if (release.status === 'PUBLISHED') return fail(409, 'ALREADY_PUBLISHED', 'This release is already live.');
  if (['WITHDRAWN', 'SUPERSEDED'].includes(release.status)) {
    return fail(409, 'INVALID_TRANSITION', `A ${release.status.toLowerCase()} release cannot be published again. Create a new release.`);
  }
  const src = body && typeof body === 'object' ? body : {};
  const { values: sched, errors } = P.readReleaseInput(src, { allowed: ['scheduledAt', 'scheduleTimeZone'] });
  if (errors) return fail(400, 'VALIDATION_FAILED', errors[0].message, { errors });
  if (!P.validatePlayStoreUrl(release.playStoreUrl)) return fail(400, 'VALIDATION_FAILED', 'The Play Store URL is not the official listing.');
  if (release.minimumSupportedVersionCode > release.versionCode) return fail(400, 'VALIDATION_FAILED', 'Minimum supported version code is above this release.');

  const live = await AppRelease.findOne({ platform: PLATFORM, status: 'PUBLISHED' }).lean();
  if (live && String(live._id) !== String(release._id)) {
    if (release.versionCode === live.versionCode) return fail(409, 'DUPLICATE_VERSION', 'The live release already has this versionCode.');
    if (release.versionCode < live.versionCode) {
      return fail(409, 'DOWNGRADE_NOT_ALLOWED', `The live release (${live.versionName}, code ${live.versionCode}) is newer. Pause or withdraw it first.`);
    }
  }
  const highest = await AppRelease.findOne({ platform: PLATFORM, _id: { $ne: release._id }, status: { $in: ['PUBLISHED', 'PAUSED', 'SUPERSEDED'] } })
    .sort({ versionCode: -1 }).select('versionCode versionName').lean();
  if (highest && release.versionCode < highest.versionCode && src.confirmDowngrade !== true) {
    return fail(409, 'DOWNGRADE_CONFIRMATION_REQUIRED',
      `Version ${highest.versionName} (code ${highest.versionCode}) was published before. Confirm to publish an older version.`);
  }

  const scheduledAt = sched.scheduledAt || null;
  if (scheduledAt && scheduledAt.getTime() > now.getTime() + 60 * 1000) {
    const before = { status: release.status };
    release.status = 'SCHEDULED';
    release.scheduledAt = scheduledAt;
    release.scheduleTimeZone = sched.scheduleTimeZone || release.scheduleTimeZone || 'Asia/Kolkata';
    release.updatedBy = admin._id;
    release.changeLog.push(changeEntry(admin, 'SCHEDULED', { changes: { scheduledAt, scheduleTimeZone: release.scheduleTimeZone } }));
    await release.save();
    await audit(admin, 'APP_RELEASE_SCHEDULED', release, { before, after: { status: 'SCHEDULED', scheduledAt }, req });
    return ok({ release: toAdmin(release.toObject()) });
  }

  if (live && String(live._id) !== String(release._id)) {
    await AppRelease.updateOne({ _id: live._id, status: 'PUBLISHED' }, {
      $set: { status: 'SUPERSEDED', supersededAt: now },
      $push: { changeLog: { $each: [changeEntry(admin, 'SUPERSEDED', { changes: { by: String(release._id) } })], $slice: -CHANGELOG_CAP } },
    });
  }
  const before = { status: release.status };
  try {
    const published = await AppRelease.findOneAndUpdate(
      { _id: release._id, status: { $in: ['DRAFT', 'SCHEDULED', 'PAUSED'] } },
      {
        $set: { status: 'PUBLISHED', publishedAt: release.publishedAt || now, pausedAt: null, scheduledAt: null, updatedBy: admin._id },
        $push: { changeLog: { $each: [changeEntry(admin, before.status === 'PAUSED' ? 'RESUMED' : 'PUBLISHED')], $slice: -CHANGELOG_CAP } },
      },
      { new: true }
    ).lean();
    if (!published) return fail(409, 'INVALID_TRANSITION', 'The release changed meanwhile. Reload and try again.');
    await audit(admin, 'APP_RELEASE_PUBLISHED', published, { before, after: { status: 'PUBLISHED' }, req });
    return ok({ release: toAdmin(published), superseded: live && String(live._id) !== String(release._id) ? String(live._id) : null });
  } catch (e) {
    if (e && e.code === 11000) return fail(409, 'ANOTHER_RELEASE_LIVE', 'Another release went live at the same moment. Reload and try again.');
    throw e;
  }
}

async function pauseRelease(admin, id, body, req) {
  if (!isId(id)) return fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
  const { reason, error } = readReason(body, false);
  if (error) return error;
  const release = await AppRelease.findById(id);
  if (!release) return fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
  const before = { status: release.status };
  if (release.status === 'PUBLISHED') {
    release.status = 'PAUSED';
    release.pausedAt = new Date();
  } else if (release.status === 'SCHEDULED') {
    release.status = 'DRAFT';           // pausing a scheduled release cancels the schedule
    release.scheduledAt = null;
  } else {
    return fail(409, 'INVALID_TRANSITION', `A ${release.status.toLowerCase()} release cannot be paused.`);
  }
  release.updatedBy = admin._id;
  release.changeLog.push(changeEntry(admin, before.status === 'SCHEDULED' ? 'UNSCHEDULED' : 'PAUSED', { reason }));
  await release.save();
  await audit(admin, 'APP_RELEASE_PAUSED', release, { reason, before, after: { status: release.status }, req });
  return ok({ release: toAdmin(release.toObject()) });
}

async function withdrawRelease(admin, id, body, req) {
  if (!isId(id)) return fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
  const { reason, error } = readReason(body, true);
  if (error) return error;
  const release = await AppRelease.findById(id);
  if (!release) return fail(404, 'RELEASE_NOT_FOUND', 'Release not found.');
  if (['WITHDRAWN', 'SUPERSEDED'].includes(release.status)) {
    return fail(409, 'INVALID_TRANSITION', `A ${release.status.toLowerCase()} release cannot be withdrawn.`);
  }
  const before = { status: release.status };
  release.status = 'WITHDRAWN';
  release.withdrawnAt = new Date();
  release.scheduledAt = null;
  release.updatedBy = admin._id;
  release.changeLog.push(changeEntry(admin, 'WITHDRAWN', { reason }));
  await release.save();   // kept as history, never deleted
  await audit(admin, 'APP_RELEASE_WITHDRAWN', release, { reason, before, after: { status: 'WITHDRAWN' }, req });
  return ok({ release: toAdmin(release.toObject()) });
}

// ── Analytics ─────────────────────────────────────────────────────────────────

async function analytics(query = {}, now = new Date()) {
  const days = Math.min(Math.max(parseInt(query.days, 10) || 30, 7), 90);
  const live = await liveRelease(now);
  const activeSince = new Date(now.getTime() - ACTIVE_WINDOW_DAYS * DAY_MS);

  const byVersion = await AppVersionTelemetry.aggregate([
    { $match: { platform: PLATFORM, lastSeenAt: { $gte: activeSince } } },
    { $sort: { lastSeenAt: -1 } },
    { $group: { _id: '$versionCode', users: { $sum: 1 }, versionName: { $first: '$versionName' } } },
    { $sort: { _id: -1 } },
  ]);
  const totalActive = byVersion.reduce((s, v) => s + v.users, 0);
  const sum = pred => byVersion.filter(v => pred(v._id)).reduce((s, v) => s + v.users, 0);

  const counts = live ? {
    onLatest: sum(c => c === live.versionCode),
    olderThanLatest: sum(c => c < live.versionCode),
    belowMinimum: sum(c => c < live.minimumSupportedVersionCode),
    aheadOfLatest: sum(c => c > live.versionCode),
  } : { onLatest: null, olderThanLatest: null, belowMinimum: null, aheadOfLatest: null };

  // Adoption of the live release over time: users whose reported version first reached it, per day.
  let adoption = [];
  if (live) {
    const since = new Date(now.getTime() - (days - 1) * DAY_MS);
    const firstReached = await AppVersionTelemetry.aggregate([
      { $match: { platform: PLATFORM } },
      { $unwind: '$history' },
      { $match: { 'history.versionCode': { $gte: live.versionCode } } },
      { $group: { _id: '$userId', at: { $min: '$history.at' } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: 'Asia/Kolkata' } }, users: { $sum: 1 } } },
    ]);
    const perDay = new Map(firstReached.map(d => [d._id, d.users]));
    let cumulative = firstReached.filter(d => d._id < istDay(since.getTime())).reduce((s, d) => s + d.users, 0);
    for (let i = 0; i < days; i++) {
      const day = istDay(since.getTime() + i * DAY_MS);
      cumulative += perDay.get(day) || 0;
      adoption.push({ day, newUsers: perDay.get(day) || 0, cumulativeUsers: cumulative });
    }
  }

  // Prompt counters for the live release (no user ids are ever stored for these).
  let prompts = null;
  if (live) {
    const rows = await AppUpdateEventDaily.aggregate([
      { $match: { releaseId: live._id } },
      { $group: { _id: '$event', count: { $sum: '$count' } } },
    ]);
    const m = Object.fromEntries(rows.map(r => [r._id, r.count]));
    prompts = { impressions: m.IMPRESSION || 0, clicks: m.CLICK || 0, dismissals: m.DISMISS || 0, postponements: m.POSTPONE || 0 };
  }

  return ok({
    generatedAt: now,
    activeWindowDays: ACTIVE_WINDOW_DAYS,
    liveRelease: live ? { id: String(live._id), versionName: live.versionName, versionCode: live.versionCode, minimumSupportedVersionCode: live.minimumSupportedVersionCode, updatePolicy: live.updatePolicy, rolloutPercentage: live.rolloutPercentage, publishedAt: live.publishedAt } : null,
    totalActiveUsers: totalActive,
    ...counts,
    versions: byVersion.map(v => ({ versionCode: v._id, versionName: v.versionName, users: v.users })),
    adoption,
    prompts,
    note: 'Counts come from the versions signed-in users’ apps report on their update check. Apps released before update checks existed report nothing.',
  });
}

module.exports = {
  PLATFORM, activateDueReleases, liveRelease, checkForClient, recordEvent, recordInstalledVersion,
  listReleases, getRelease, createRelease, updateRelease, publishRelease, pauseRelease, withdrawRelease, analytics,
  toAdmin, istDay,
};
