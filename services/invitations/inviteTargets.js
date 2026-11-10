// services/invitations/inviteTargets.js — one adapter per group type.
//
// Each adapter answers the same questions for its own model, using that feature's
// EXISTING rules and join code (nothing here re-implements a join):
//
//   load(id)                        the group document (lean), or null
//   isMember(userId, group)         currently a member?
//   canInvite(userId, group)        may this member create a link right now?
//   expiryCap(group)                latest moment a link to it may stay valid
//   state(group)                    OPEN | FULL | ENDED (as anyone would see it)
//   preview(group, {detailed})      the PUBLIC description — never ids, members,
//                                   messages, addresses or coordinates
//   navigation(group, userId)       what the app needs to open the chat (members only)
//   join({user, group, io})         the feature's own join → normalised outcome
//   counterpartIds(group)           everyone a block with the joiner should stop
//
// Normalised join outcome: { ok: true, alreadyMember?: bool } or { ok: false, code }.
'use strict';

const mongoose = require('mongoose');
const HumrahRoom = require('../../models/HumrahRoom');
const RoomMember = require('../../models/RoomMember');
const SportsPlan = require('../../models/SportsPlan');
const MovieSession = require('../../models/MovieSession');
const { resolveRoomTopicImage } = require('../../utils/roomTopicConfig');
const { resolveSportImageUrl } = require('../../utils/sportsImageConfig');

const DAY = 24 * 60 * 60 * 1000;
const MAX_LIFETIME_MS = 7 * DAY;
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w780';

const isId = (v) => mongoose.isValidObjectId(v);
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const includesId = (list, id) => (list || []).some((x) => sameId(x, id));
const clip = (s, n) => {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const titleCase = (s) => String(s || '')
  .split(/[_\s]+/).filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .join(' ');
const cityLabel = (c) => clip(titleCase(c), 40);

/** An absolute https TMDB poster URL from what MovieSession.poster stores (a TMDB path). */
function tmdbPosterUrl(poster) {
  if (typeof poster !== 'string' || !poster.trim()) return null;
  const p = poster.trim();
  if (/^https:\/\//i.test(p)) return p;
  if (/^\/[A-Za-z0-9_\-./]+\.(jpg|jpeg|png|webp)$/i.test(p) && !p.includes('..')) return `${TMDB_IMAGE_BASE}${p}`;
  return null;
}

// ── ROOM ──────────────────────────────────────────────────────────────────────
const ROOM = {
  type: 'ROOM',
  label: 'Humrah Room',
  async load(id) {
    if (!isId(id)) return null;
    return HumrahRoom.findById(id).lean();
  },
  async isMember(userId, room) {
    return !!(await RoomMember.exists({ roomId: room._id, userId, status: 'JOINED' }));
  },
  async canInvite(userId, room) {
    if (['INACTIVE', 'CLOSED'].includes(room.status)) return { ok: false, code: 'GROUP_ENDED' };
    const m = await RoomMember.findOne({ roomId: room._id, userId, status: 'JOINED' }).select('role').lean();
    if (!m) return { ok: false, code: 'NOT_A_MEMBER' };
    // A PRIVATE Room is invite-only; only its host hands out links to it.
    if (room.discoveryMode === 'PRIVATE' && m.role !== 'HOST' && !sameId(room.createdBy, userId)) {
      return { ok: false, code: 'HOST_ONLY' };
    }
    return { ok: true };
  },
  expiryCap(room) {
    const caps = [Date.now() + MAX_LIFETIME_MS];
    if (room.expiresAt && room.status === 'SUGGESTED') caps.push(new Date(room.expiresAt).getTime());
    return new Date(Math.min(...caps));
  },
  state(room) {
    if (['INACTIVE', 'CLOSED'].includes(room.status)) return 'ENDED';
    if (room.status === 'FULL') return 'FULL';
    return 'OPEN';
  },
  async preview(room) {
    // The denormalised memberCount can lag behind (pre-backfill Rooms); count the members.
    const memberCount = await RoomMember.countDocuments({ roomId: room._id, status: 'JOINED' });
    const modeLabel = room.discoveryMode === 'ALL_INDIA' ? 'All India'
      : room.discoveryMode === 'NEAR_ME' ? 'Nearby' : 'Private';
    return {
      title: clip(room.title, 60) || 'Humrah Room',
      description: clip(room.description, 160),
      topic: clip(room.topic, 40),
      imageUrl: resolveRoomTopicImage(room.topic),
      memberCount,
      capacity: room.capacity || null,
      whenAt: null,
      placeLabel: modeLabel,
      languages: (room.languages || []).slice(0, 3).map((l) => clip(String(l), 20)).filter(Boolean),
    };
  },
  async navigation(room) {
    return { roomId: String(room._id), title: room.title };
  },
  async counterpartIds() { return []; }, // joinRoomAsUser checks creator + every member itself
  async join({ user, group, io }) {
    const { joinRoomAsUser } = require('../roomJoinService');
    const r = await joinRoomAsUser({ userId: user._id, roomId: group._id, io, viaInvite: true });
    switch (r.code) {
      case 'JOINED': return { ok: true };
      case 'ALREADY_MEMBER': return { ok: true, alreadyMember: true };
      case 'FULL': return { ok: false, code: 'GROUP_FULL' };
      case 'CLOSED': return { ok: false, code: 'GROUP_ENDED' };
      case 'NOT_FOUND': return { ok: false, code: 'GROUP_DELETED' };
      case 'KICKED':
      case 'BLOCKED': return { ok: false, code: 'BLOCKED' };
      case 'ACCOUNT_NOT_ELIGIBLE': return { ok: false, code: 'ACCOUNT_NOT_ELIGIBLE' };
      case 'BUSY': return { ok: false, code: 'JOIN_BUSY' };
      default: return { ok: false, code: 'JOIN_FAILED' };
    }
  },
};

// ── SPORTS ────────────────────────────────────────────────────────────────────
const sportLabel = (plan) => clip(plan.customSportName, 30) || titleCase(plan.sportType) || 'Sports';

const SPORTS = {
  type: 'SPORTS',
  label: 'Sports Plan',
  async load(id) {
    if (!isId(id)) return null;
    return SportsPlan.findById(id).lean();
  },
  async isMember(userId, plan) { return includesId(plan.playersJoined, userId); },
  async canInvite(userId, plan) {
    if (!includesId(plan.playersJoined, userId)) return { ok: false, code: 'NOT_A_MEMBER' };
    if (SPORTS.state(plan) === 'ENDED') return { ok: false, code: 'GROUP_ENDED' };
    return { ok: true };
  },
  expiryCap(plan) {
    // Joins close when the game starts (sportsPlanService.joinPlan), so does the link.
    return new Date(Math.min(Date.now() + MAX_LIFETIME_MS, new Date(plan.startTime).getTime()));
  },
  state(plan) {
    if (plan.cardStatus !== 'open' || new Date(plan.startTime).getTime() <= Date.now()) return 'ENDED';
    if ((plan.playersJoined || []).length >= plan.playerLimit) return 'FULL';
    return 'OPEN';
  },
  preview(plan, { detailed = false } = {}) {
    const sport = sportLabel(plan);
    const skill = plan.skillLevel && plan.skillLevel !== 'any' ? titleCase(plan.skillLevel) : null;
    return {
      title: `${sport} game`,
      description: clip(plan.note, 120),
      topic: sport,
      skillLevel: skill,
      imageUrl: resolveSportImageUrl(plan.sportType),
      memberCount: (plan.playersJoined || []).length,
      capacity: plan.playerLimit,
      whenAt: plan.startTime ? new Date(plan.startTime).toISOString() : null,
      // The venue is a public place (court, ground, gym), shown to signed-in users;
      // the public page shows the city only. Never coordinates or the street address.
      placeLabel: detailed ? (clip(plan.venue?.name, 60) || cityLabel(plan.city)) : cityLabel(plan.city),
    };
  },
  async navigation(plan) {
    const sessions = require('../sportsSessionService');
    const sessionId = await sessions.sessionIdForMember(plan);
    return { planId: String(plan._id), sessionId };
  },
  async counterpartIds() { return []; }, // joinPlan checks the creator itself
  async join({ user, group, io }) {
    const svc = require('../sportsPlanService');
    const r = await svc.joinPlan(user, String(group._id));
    if (r.success) {
      // Exactly what POST /api/sports-plans/:id/join emits after a join.
      const { emitPlanJoined, emitSessionParticipantJoined } = require('../../sockets/sportsSocket');
      emitPlanJoined(io, r.plan, user);
      emitSessionParticipantJoined(io, r.session, r.plan, user);
      return { ok: true };
    }
    switch (r.code) {
      case 'ALREADY_JOINED': return { ok: true, alreadyMember: true };
      case 'VERIFICATION_REQUIRED': return { ok: false, code: 'VERIFICATION_REQUIRED' };
      case 'USER_KICKED': return { ok: false, code: 'BLOCKED' };
      case 'PLAN_CLOSED': return { ok: false, code: 'GROUP_ENDED' };
      case 'PLAN_FULL': return { ok: false, code: 'GROUP_FULL' };
      case 'PLAN_NOT_FOUND': return { ok: false, code: 'GROUP_DELETED' };
      case 'JOIN_CONFLICT': return { ok: false, code: 'JOIN_BUSY' };
      default: return { ok: false, code: 'JOIN_FAILED' };
    }
  },
};

// ── MOVIE ─────────────────────────────────────────────────────────────────────
const MOVIE = {
  type: 'MOVIE',
  label: 'Movie Hangout',
  async load(id) {
    if (!isId(id)) return null;
    return MovieSession.findById(id).lean();
  },
  async isMember(userId, s) { return includesId(s.participants, userId); },
  async canInvite(userId, s) {
    if (!includesId(s.participants, userId)) return { ok: false, code: 'NOT_A_MEMBER' };
    if (MOVIE.state(s) === 'ENDED') return { ok: false, code: 'GROUP_ENDED' };
    return { ok: true };
  },
  expiryCap(s) {
    return new Date(Math.min(Date.now() + MAX_LIFETIME_MS, new Date(s.expiresAt).getTime()));
  },
  state(s) {
    if (s.status === 'expired' || new Date(s.expiresAt).getTime() <= Date.now()) return 'ENDED';
    if ((s.participants || []).length >= s.maxParticipants) return 'FULL';
    return 'OPEN';
  },
  preview(s, { detailed = false } = {}) {
    return {
      title: clip(s.movieTitle, 80) || 'Movie Hangout',
      description: null,
      topic: clip(s.language, 20),
      imageUrl: tmdbPosterUrl(s.poster),
      memberCount: (s.participants || []).length,
      capacity: s.maxParticipants,
      whenAt: s.showTime ? new Date(s.showTime).toISOString() : null,
      // A theatre is a public business; still, the public page shows the city only.
      placeLabel: detailed ? (clip(s.theatreName, 60) || cityLabel(s.city)) : cityLabel(s.city),
    };
  },
  async navigation(s) {
    return {
      sessionId: String(s._id),
      chatId: s.chatId ? String(s.chatId) : null,
      movieTitle: s.movieTitle,
      posterPath: typeof s.poster === 'string' ? s.poster : null,
      chatExpiresAt: s.chatExpiresAt ? new Date(s.chatExpiresAt).toISOString() : null,
    };
  },
  // Movie joins have no block check of their own, so the invitation adds one:
  // nobody joins a hangout with someone on either side of a block.
  async counterpartIds(s) { return (s.participants || []).map(String); },
  async join({ user, group, io }) {
    const svc = require('../movieSessionService');
    const r = await svc.joinSession(user._id, String(group._id), io);
    if (r.success) {
      return r.message === 'Already a member' ? { ok: true, alreadyMember: true } : { ok: true };
    }
    switch (r.code) {
      case 'VERIFICATION_REQUIRED': return { ok: false, code: 'VERIFICATION_REQUIRED' };
      case 'SESSION_EXPIRED': return { ok: false, code: 'GROUP_ENDED' };
      case 'SESSION_FULL': return { ok: false, code: 'GROUP_FULL' };
      case 'SESSION_NOT_FOUND': return { ok: false, code: 'GROUP_DELETED' };
      default: return { ok: false, code: 'JOIN_FAILED' };
    }
  },
};

const ADAPTERS = Object.freeze({ ROOM, SPORTS, MOVIE });

module.exports = { ADAPTERS, adapterFor: (type) => ADAPTERS[type] || null, tmdbPosterUrl, MAX_LIFETIME_MS };
