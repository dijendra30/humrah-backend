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
const MAX_VIDEOS     = 30;   // applied AFTER filtering + ranking (see _mapVideos)

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

// YouTube video IDs: 11 characters of [A-Za-z0-9_-].
const YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{11}$/;

// Playable trailer candidates only, best first, THEN capped.
//
// Why: TMDB lists every video newest-first — a big release can have 200+ (Spider-Man:
// Brand New Day: 221, of which 3 English trailers sit at positions 106–218, behind
// featurettes and teasers). Capping the raw list first threw every trailer away.
//
// Rank: Trailer+official, Trailer, Teaser+official, Teaser; English before other
// languages (the app is English); then TMDB's original order. The client makes the
// final, deterministic pick from this list (TrailerSelector).
function _mapVideos(results) {
  if (!Array.isArray(results)) return [];
  const tier = v => {
    const trailer = v.type.toLowerCase() === 'trailer';
    return (trailer ? 0 : 2) + (v.official === true ? 0 : 1);
  };
  return results
    .map((v, index) => ({ v, index }))
    .filter(({ v }) => v && typeof v === 'object'
      && _str(v.site) && v.site.trim().toLowerCase() === 'youtube'
      && _str(v.type) && ['trailer', 'teaser'].includes(v.type.trim().toLowerCase())
      && _str(v.key) && YOUTUBE_KEY_RE.test(v.key.trim()))
    .map(({ v, index }) => ({
      index,
      video: {
        key:         v.key.trim(),
        name:        _str(v.name),
        site:        v.site.trim(),
        type:        v.type.trim(),
        official:    typeof v.official === 'boolean' ? v.official : null,
        size:        Number.isInteger(v.size) ? v.size : null,
        publishedAt: _str(v.published_at),
        language:    _str(v.iso_639_1),
      },
    }))
    .sort((a, b) =>
      (tier(a.video) - tier(b.video))
      || ((a.video.language === 'en' ? 0 : 1) - (b.video.language === 'en' ? 0 : 1))
      || (a.index - b.index))
    .slice(0, MAX_VIDEOS)
    .map(x => x.video);
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
