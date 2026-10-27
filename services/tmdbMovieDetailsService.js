// services/tmdbMovieDetailsService.js
// ─────────────────────────────────────────────────────────────────────────────
// One movie's details + video metadata, for the Home movie-details sheet.
//
//   GET {TMDB}/movie/{id}          → title, overview, poster, release date, genres
//   GET {TMDB}/movie/{id}/videos   → trailers / teasers / clips (metadata only)
//
// Same TMDB key, base URL and fetch() style as movieSessionService.js — the key
// never leaves the server. Nothing is invented: a missing field stays null, a
// movie with no videos returns an empty list, and the client decides which (if
// any) video is a playable trailer.
//
// Cache: in-memory, bounded. A found movie is kept 6 h; a TMDB "not found" for
// 10 min; failures (timeout, rate limit, outage) are never cached, so the next
// tap retries.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const DETAILS_TTL    = 6 * 60 * 60 * 1000;
const NOT_FOUND_TTL  = 10 * 60 * 1000;
const CACHE_MAX      = 200;
const TIMEOUT_MS     = 8000;
const MAX_VIDEOS     = 30;

// TMDB movie IDs are positive integers. Anything else never reaches TMDB.
const MOVIE_ID_RE = /^[1-9][0-9]{0,9}$/;

// Indian-first like the rest of Movie Hangout; "null" = videos with no language set.
const VIDEO_LANGUAGES = 'en,hi,ta,te,ml,kn,bn,mr,gu,pa,null';

const _cache = new Map();   // movieId → { ts, ttl, result }

function _cacheGet(id) {
  const hit = _cache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.ts > hit.ttl) { _cache.delete(id); return null; }
  return hit.result;
}

function _cacheSet(id, result, ttl) {
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);   // oldest first
  _cache.set(id, { ts: Date.now(), ttl, result });
}

function _str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

function _mapDetails(m) {
  return {
    id:          m.id,
    title:       _str(m.title),
    overview:    _str(m.overview),
    posterPath:  _str(m.poster_path),
    releaseDate: _str(m.release_date),
    runtime:     Number.isInteger(m.runtime) && m.runtime > 0 ? m.runtime : null,
    genres:      Array.isArray(m.genres) ? m.genres.map(g => _str(g && g.name)).filter(Boolean) : [],
  };
}

// Only well-formed entries; the fields the client needs to pick a trailer.
function _mapVideos(results) {
  if (!Array.isArray(results)) return [];
  return results
    .filter(v => v && _str(v.key) && _str(v.site) && _str(v.type))
    .slice(0, MAX_VIDEOS)
    .map(v => ({
      key:         v.key.trim(),
      name:        _str(v.name),
      site:        v.site.trim(),
      type:        v.type.trim(),
      official:    typeof v.official === 'boolean' ? v.official : null,
      size:        Number.isInteger(v.size) ? v.size : null,
      publishedAt: _str(v.published_at),
    }));
}

async function _tmdb(url, fetchImpl) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{success, status, code?, message?, movie?, videos?, videosAvailable?}>}
 *          shaped for movieSessionController's send(): `status` becomes the HTTP code.
 */
async function getMovieDetails(rawId, { fetchImpl = fetch } = {}) {
  const movieId = String(rawId ?? '').trim();
  if (!MOVIE_ID_RE.test(movieId)) {
    return { success: false, status: 400, code: 'INVALID_MOVIE_ID', message: 'Invalid movie' };
  }

  const cached = _cacheGet(movieId);
  if (cached) return { ...cached };

  const KEY = process.env.TMDB_API_KEY;
  if (!KEY) {
    console.warn('[movieDetails] TMDB_API_KEY not set');
    return { success: false, status: 503, code: 'MOVIE_DETAILS_UNAVAILABLE', message: 'Movie details are not available right now' };
  }
  const BASE = process.env.TMDB_BASE_URL || 'https://api.tmdb.org/3';

  const detailsUrl = `${BASE}/movie/${movieId}?${new URLSearchParams({ api_key: KEY, language: 'en-US' })}`;
  const videosUrl  = `${BASE}/movie/${movieId}/videos?${new URLSearchParams({ api_key: KEY, language: 'en-US', include_video_language: VIDEO_LANGUAGES })}`;

  const [detailsSettled, videosSettled] = await Promise.allSettled([
    _tmdb(detailsUrl, fetchImpl),
    _tmdb(videosUrl,  fetchImpl),
  ]);

  // ── Details decide the outcome ─────────────────────────────────────────────
  if (detailsSettled.status !== 'fulfilled') {
    console.warn(`[movieDetails] ${movieId} details failed: ${detailsSettled.reason?.name || 'error'}`);
    return { success: false, status: 503, code: 'MOVIE_DETAILS_UNAVAILABLE', message: 'Movie details are not available right now' };
  }
  const dRes = detailsSettled.value;
  if (dRes.status === 404) {
    const result = { success: false, status: 404, code: 'MOVIE_NOT_FOUND', message: 'Movie not found' };
    _cacheSet(movieId, result, NOT_FOUND_TTL);
    return { ...result };
  }
  if (!dRes.ok) {
    console.warn(`[movieDetails] ${movieId} details HTTP ${dRes.status}`);
    return {
      success: false, status: 503,
      code: dRes.status === 429 ? 'MOVIE_DETAILS_RATE_LIMITED' : 'MOVIE_DETAILS_UNAVAILABLE',
      message: 'Movie details are not available right now',
    };
  }
  let movie;
  try {
    const body = await dRes.json();
    if (!body || typeof body !== 'object' || !body.id) throw new Error('malformed');
    movie = _mapDetails(body);
  } catch (_) {
    console.warn(`[movieDetails] ${movieId} details malformed`);
    return { success: false, status: 503, code: 'MOVIE_DETAILS_UNAVAILABLE', message: 'Movie details are not available right now' };
  }

  // ── Videos are best-effort: details still show without them ────────────────
  let videos = [];
  let videosAvailable = false;
  if (videosSettled.status === 'fulfilled' && videosSettled.value.ok) {
    try {
      const body = await videosSettled.value.json();
      videos = _mapVideos(body && body.results);
      videosAvailable = true;
    } catch (_) {
      console.warn(`[movieDetails] ${movieId} videos malformed`);
    }
  } else {
    const why = videosSettled.status === 'fulfilled' ? `HTTP ${videosSettled.value.status}` : (videosSettled.reason?.name || 'error');
    console.warn(`[movieDetails] ${movieId} videos failed: ${why}`);
  }

  const result = { success: true, status: 200, movie, videos, videosAvailable };
  // Only a complete answer is cached, so a videos outage is retried next time.
  if (videosAvailable) _cacheSet(movieId, result, DETAILS_TTL);
  return { ...result };
}

function _clearCacheForTests() { _cache.clear(); }

module.exports = { getMovieDetails, _clearCacheForTests };
