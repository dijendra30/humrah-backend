// utils/roomSearch.js
// -----------------------------------------------------------------------------
// Rooms Phase 2.2 — search, topic filter and pagination for POST /api/rooms/discover.
//
// All new request fields are OPTIONAL. A request without them behaves as before:
// first page of the ranked list (40 Rooms, the old cap). Pure helpers, no I/O.
//
// Search is server-side: the filter is applied inside the Room query, so a match
// is found even when it is not among the newest Rooms, and the Android client
// never downloads the inventory to filter it locally.
// -----------------------------------------------------------------------------
'use strict';

const { canonicalizeTopic } = require('./roomTopicConfig');

const MAX_QUERY_CHARS = 50;
const DEFAULT_PAGE_SIZE = 40;   // = the pre-2.2 discovery cap, so old clients see the same size
const MAX_PAGE_SIZE = 40;
const MAX_OFFSET = 1000;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseIntParam(v, { min, max, fallback }) {
  if (v === undefined || v === null || v === '') return { value: fallback };
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < min || n > max) return { error: true };
  return { value: n };
}

/**
 * Validates the optional discovery fields.
 * @returns {{ query: ?string, topic: ?string, offset: number, limit: number } | { error: string }}
 */
function parseDiscoveryParams(body = {}) {
  let query = null;
  if (body.query !== undefined && body.query !== null) {
    if (typeof body.query !== 'string') return { error: 'Invalid search text' };
    const q = body.query.replace(/\s+/g, ' ').trim();
    if (q.length > MAX_QUERY_CHARS) return { error: `Search text must be at most ${MAX_QUERY_CHARS} characters` };
    query = q || null;
  }

  let topic = null;
  if (body.topic !== undefined && body.topic !== null && body.topic !== '') {
    if (typeof body.topic !== 'string') return { error: 'Invalid topic' };
    topic = canonicalizeTopic(body.topic);
    if (!topic) return { error: 'Invalid topic' };
  }

  const offset = parseIntParam(body.offset, { min: 0, max: MAX_OFFSET, fallback: 0 });
  if (offset.error) return { error: 'Invalid offset' };
  const limit = parseIntParam(body.limit, { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE });
  if (limit.error) return { error: 'Invalid limit' };

  return { query, topic, offset: offset.value, limit: limit.value };
}

/**
 * Mongo filter for the search fields ({} when there is none).
 * query: case-insensitive substring of the title OR the topic (topic = the category).
 * topic: the Room's topic equals the canonical topic, ignoring case (createRoom stores
 *        the spelling the client sent, so "food & cooking" and "Food & Cooking" both exist).
 */
function buildSearchFilter({ query, topic } = {}) {
  const and = [];
  if (query) {
    const rx = new RegExp(escapeRegex(query), 'i');
    and.push({ $or: [{ title: rx }, { topic: rx }] });
  }
  if (topic) and.push({ topic: new RegExp(`^${escapeRegex(topic)}$`, 'i') });
  return and.length ? { $and: and } : {};
}

/** Same rule as buildSearchFilter, for Rooms already in memory. */
function matchesSearch(room, { query, topic } = {}) {
  const title = String(room?.title || '').toLowerCase();
  const roomTopic = String(room?.topic || '').toLowerCase();
  if (query) {
    const q = query.toLowerCase();
    if (!title.includes(q) && !roomTopic.includes(q)) return false;
  }
  if (topic && roomTopic !== topic.toLowerCase()) return false;
  return true;
}

/** Offset page of an already-ranked list. nextOffset is null on the last page. */
function paginate(list, offset, limit) {
  const page = list.slice(offset, offset + limit);
  const hasMore = offset + limit < list.length;
  return { page, hasMore, nextOffset: hasMore ? offset + limit : null };
}

module.exports = {
  MAX_QUERY_CHARS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_OFFSET,
  escapeRegex,
  parseDiscoveryParams,
  buildSearchFilter,
  matchesSearch,
  paginate,
};
