// services/movieSessionService.js
// ─────────────────────────────────────────────────────────────────────────────
// ALL business logic lives here. Controller is a thin HTTP adapter.
//
// ARCHITECTURE:
//  fetchTrendingMovies()        → TMDB API → FALLBACK_MOVIES
//  fetchNearbyTheatres()        → Google Places API v1 → fallback at user coords
//  searchTheatres()             → Google Places Text Search v1
//  generateSystemSessions()     → auto-seed feed, empty participants, no fakes
//  getNearbySessions()          → strict 4-step flow per spec
//  createSession()              → user-created session + welcome chat msg
//  joinSession()                → atomic admin assignment + chat message
//  getSessionChat()             → member-only access
//  sendMessage()                → push to chat + socket emit
//  sendPostSessionNotifications() → FCM push after expiry
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const mongoose     = require('mongoose');
const MovieSession = require('../models/MovieSession');
const MovieChat    = require('../models/MovieChat');
const MovieMessage = require('../models/MovieMessage');
const MovieParticipant = require('../models/MovieParticipant');
const { getTimeLabel, getParticipantDisplay, getPostSessionMessage,
        getNextShowTime, isCreationAllowed, validateShowTime, isAfterEndHour } = require('../utils/timeLabel');

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_LANGUAGE  = 'Hindi';
const MAX_RADIUS_M      = 20_000;   // 20 km initial fetch
const WIDE_RADIUS_M     = 50_000;   // 50 km fallback

// ── TMDB language code → session display label ────────────────────────────────
// Used by generateSystemSessions() to derive session language from the movie.
// Only Hindi and English are supported for system-generated sessions (Humrah spec).
const _LANG_DISPLAY = { hi: 'Hindi', en: 'English' };

// ─── Fallback movies (used ONLY when TMDB key missing / request fails) ───────
// Hindi-first per Humrah spec. Updated for 2024–2025 Indian theatrical slate.
// posterPath is null (no image in outage mode). IDs are TMDB movie IDs.
const FALLBACK_MOVIES = [
  { id: '1295691', title: 'Pushpa 2: The Rule',               posterPath: null, language: 'hi', popularity: 98 },
  { id: '1262229', title: 'Stree 2',                          posterPath: null, language: 'hi', popularity: 95 },
  { id: '1221931', title: 'Singham Again',                    posterPath: null, language: 'hi', popularity: 78 },
  { id: '1011985', title: 'Fighter',                          posterPath: null, language: 'hi', popularity: 75 },
  { id: '1350480', title: 'Sky Force',                        posterPath: null, language: 'hi', popularity: 72 },
  { id: '822119',  title: 'Captain America: Brave New World', posterPath: null, language: 'en', popularity: 88 },
];

// Fallback theatres placed AT user coords so geo queries always find them
function _buildFallbackTheatres(lat, lng) {
  return [
    { placeId: 'fb_1', name: 'City Multiplex', address: 'City Centre',
      rating: 4.0, lat,              lng,              distance: 0    },
    { placeId: 'fb_2', name: 'PVR Cinemas',    address: 'Mall Road',
      rating: 4.2, lat: lat + 0.005, lng: lng + 0.005, distance: 700  },
    { placeId: 'fb_3', name: 'INOX Megaplex',  address: 'High Street',
      rating: 3.8, lat: lat + 0.009, lng: lng - 0.003, distance: 1100 },
  ];
}

// ─── TMDB cache (15 min in-memory) ───────────────────────────────────────────
let _moviesCache = { data: null, ts: 0 };
const CACHE_TTL  = 15 * 60 * 1000;

// ─── Recently used movies cache (rotation — prevents same movie repeating) ───
// Tracks the last N movieIds used by the system generator across all calls.
// Cleared every 24 hours so the pool fully resets each day.
const RECENT_MOVIE_MAX   = 9;   // remember last 9 used movie IDs
const RECENT_MOVIE_TTL   = 24 * 60 * 60 * 1000; // 24 h
let _recentMovieIds      = [];  // [{ id: string, ts: number }]

function _pruneRecentMovies() {
  const cutoff = Date.now() - RECENT_MOVIE_TTL;
  _recentMovieIds = _recentMovieIds.filter(e => e.ts > cutoff);
}

function _markMovieUsed(movieId) {
  _pruneRecentMovies();
  // Remove if already present (re-insert at end = most recent)
  _recentMovieIds = _recentMovieIds.filter(e => e.id !== String(movieId));
  _recentMovieIds.push({ id: String(movieId), ts: Date.now() });
  // Keep list bounded
  if (_recentMovieIds.length > RECENT_MOVIE_MAX) {
    _recentMovieIds = _recentMovieIds.slice(_recentMovieIds.length - RECENT_MOVIE_MAX);
  }
}

function _getRecentMovieIds() {
  _pruneRecentMovies();
  return new Set(_recentMovieIds.map(e => e.id));
}

// ─── Fisher-Yates shuffle (in-place, returns array) ──────────────────────────
function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Language-priority pool builder ──────────────────────────────────────────
// Shuffles within each language bucket, then concatenates Hindi → English → other.
// This preserves randomness for variety while guaranteeing Hindi movies are always
// picked before English ones when slots are filled sequentially.
//
// WHY THIS EXISTS:
//   A flat _shuffle() on the full movie list destroys the Hindi-first ordering
//   produced by fetchTrendingMovies(). English movies randomly end up at index 0,
//   1, or 2 — the exact indices picked for the 3 daily slots. This function fixes
//   that by making the shuffle language-aware.
function _buildLangPriorityPool(src) {
  const hi    = _shuffle(src.filter(m => m.language === 'hi'));
  const en    = _shuffle(src.filter(m => m.language === 'en'));
  const other = _shuffle(src.filter(m => m.language !== 'hi' && m.language !== 'en'));
  return [...hi, ...en, ...other];
}

// ─── Haversine (metres) ───────────────────────────────────────────────────────
function _haversine(lat1, lng1, lat2, lng2) {
  const R  = 6_371_000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Fetch user language + saved location from DB ────────────────────────────
async function _fetchUserContext(userId) {
  try {
    const User = mongoose.model('User');
    const user = await User.findById(userId)
      .select('questionnaire last_known_lat last_known_lng firstName lastName profilePhoto photoVerificationStatus emailVerified')
      .lean();
    if (!user) return null;
    return {
      languagePreference: user.questionnaire?.languagePreference
                       || user.questionnaire?.language
                       || DEFAULT_LANGUAGE,
      city:      (user.questionnaire?.city || '').trim().toLowerCase(),
      lat:       user.last_known_lat || null,
      lng:       user.last_known_lng || null,
      isVerified: user.photoVerificationStatus === 'approved',
      firstName: user.firstName      || 'User',
      lastName:  user.lastName       || '',
      profilePhoto: user.profilePhoto|| null,
    };
  } catch (err) {
    console.error('[service] fetchUserContext error:', err.message);
    return null;
  }
}

// ─── Resolve best lat/lng: query params → DB → null ──────────────────────────
async function _resolveLocation(queryLat, queryLng, userId) {
  const lat = parseFloat(queryLat);
  const lng = parseFloat(queryLng);
  if (!isNaN(lat) && !isNaN(lng)) return { lat, lng, source: 'query' };
  const ctx = await _fetchUserContext(userId);
  if (ctx?.lat !== null && ctx?.lng !== null) return { lat: ctx.lat, lng: ctx.lng, source: 'db' };
  return { lat: null, lng: null, source: 'none' };
}

// ─── Tiered session fetch from DB ─────────────────────────────────────────────
// Tier 1: $nearSphere 20 km
// Tier 2: $nearSphere 50 km
// Tier 3: plain find, active + not expired (no geo)
// Tier 4: nuclear — plain find with ZERO filters (confirms data exists)
// createdBy is NEVER populated — 'system' cannot be cast to ObjectId
async function _fetchSessionsFromDB(loc, baseQuery) {
  const populateOpts = [{ path: 'participants', select: 'firstName lastName profilePhoto' }];

  if (loc.lat !== null && loc.lng !== null) {
    for (const radiusM of [MAX_RADIUS_M, WIDE_RADIUS_M]) {
      try {
        const rows = await MovieSession.find({
          ...baseQuery,
          location: {
            $nearSphere: {
              $geometry:    { type: 'Point', coordinates: [loc.lng, loc.lat] },
              $maxDistance: radiusM,
            },
          },
        }).populate(populateOpts).limit(30);

        console.log(`  [fetch] geo ${radiusM / 1000}km → ${rows.length} row(s)`);
        if (rows.length > 0) return rows;
      } catch (err) {
        console.warn(`  [fetch] geo ${radiusM}m error: ${err.message}`);
      }
    }
  }

  // Tier 3 — no geo, apply base filters
  try {
    const rows = await MovieSession.find(baseQuery)
      .populate(populateOpts)
      .sort({ createdAt: -1 })
      .limit(20);
    console.log(`  [fetch] no-geo → ${rows.length} row(s)`);
    if (rows.length > 0) return rows;
  } catch (err) {
    console.warn(`  [fetch] no-geo error: ${err.message}`);
  }

  // Tier 4 — nuclear: apply only city + status filter, NEVER zero filters
  // Zero-filter find would return cross-city sessions and break isolation.
  try {
    const nuclearQuery = baseQuery && Object.keys(baseQuery).length > 0
      ? baseQuery
      : { status: 'active' };
    const rows = await MovieSession.find(nuclearQuery).populate(populateOpts).sort({ createdAt: -1 }).limit(10);
    console.log(`  [fetch] nuclear → ${rows.length} row(s)`);
    return rows;
  } catch (err) {
    console.error(`  [fetch] nuclear error: ${err.message}`);
    return [];
  }
}

// ─── Scoring for sort ─────────────────────────────────────────────────────────
// ── SMART PRIORITY SCORING (per spec) ────────────────────────────────────────
//
//  1. Real-user sessions always beat system sessions (+200 base)
//  2. More real participants → higher rank (+10 each, max +40)
//     → "If system session gets users → increase its priority" — handled here
//  3. Earlier show time → higher rank (+2 to +20)
//  4. Language match bonus (+15)
//  5. Boosted bonus (+10)
//
function _scoreSession(session, now, userLang, userLat, userLng) {
  let score = 0;

  // 1. Real-user sessions always dominate
  if (!session.isSystemGenerated) score += 200;

  // 2. Real participant count (dynamic — system sessions climb as users join)
  const realCount = session.participants?.length || 0;
  score += Math.min(realCount * 10, 40);

  // 3. Time proximity — soonest first
  const hrs = (new Date(session.showTime) - now) / 3_600_000;
  if (hrs > 0 && hrs < 2)        score += 20;
  else if (hrs >= 2 && hrs < 6)  score += 14;
  else if (hrs >= 6 && hrs < 12) score += 8;
  else if (hrs >= 12)            score += 2;

  // 4. Language match bonus
  const langMatch = userLang === 'Both'
    || session.language === 'Both'
    || session.language === userLang;
  if (langMatch) score += 15;

  // 5. Boosted bonus
  if (session.isBoosted) score += 10;

  return score;
}

// ─── Format session for API response ─────────────────────────────────────────
function _formatSession(session, currentUserId, distMetres = null) {
  const s          = session.toObject ? session.toObject() : session;
  const creatorStr = s.createdBy?.toString?.() || 'system';
  const isSystem   = s.isSystemGenerated || creatorStr === 'system';

  // Real participants only
  const participants = (s.participants || [])
    .filter(p => p && typeof p === 'object' && p._id)
    .map(p => ({
      id:           p._id.toString(),
      firstName:    p.firstName    || '',
      profilePhoto: p.profilePhoto || null,
    }));

  const count = participants.length;
  const participantDisplay = getParticipantDisplay(count, s.maxParticipants);

  return {
    id:                 s._id.toString(),
    movieId:            s.movieId,
    title:              s.movieTitle,
    posterPath:         s.poster || null,
    language:           s.language || DEFAULT_LANGUAGE,
    theatreName:        s.theatreName,
    theatreAddress:     s.theatreAddress,
    date:               s.date || '',
    time:               s.time || '',
    showTime:           s.showTime?.toISOString()      || null,
    expiresAt:          s.expiresAt?.toISOString()     || null,
    chatExpiresAt:      s.chatExpiresAt?.toISOString() || null,
    // Time label — social urgency
    timeLabel:          getTimeLabel(s.showTime),
    // Participant display — honest social proof
    participantDisplay,
    participants,
    participantsCount:  count,
    maxParticipants:    s.maxParticipants,
    spotsLeft:          s.maxParticipants - count,
    adminId:            s.adminId?.toString() || null,
    isSystemGenerated:  isSystem,
    isBoosted:          s.isBoosted || false,
    status:             s.status,
    chatId:             s.chatId?.toString() || null,
    distance:           distMetres !== null ? Math.round(distMetres) : null,
    isCreator:          currentUserId ? creatorStr === currentUserId.toString() : false,
    hasJoined:          currentUserId
                          ? participants.some(p => p.id === currentUserId.toString())
                          : false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchTrendingMovies — India-first movie pool for system-generated sessions
//
// SOURCES (fetched in parallel, merged with source-priority dedup):
//   1. /movie/now_playing?region=IN (page 1)  ← highest priority: in theatres NOW
//   2. /movie/now_playing?region=IN (page 2)  ← extends the IN now-playing pool
//   3. /movie/popular?region=IN&with_original_language=hi  ← dedicated Hindi popular
//   4. /movie/popular?region=IN               ← India-popular across all languages
//   5. /trending/movie/week                   ← global trending (blockbuster catches)
//
// LANGUAGE FILTER (Humrah spec — Delhi launch):
//   Priority 1 → Hindi   (original_language = 'hi')
//   Priority 2 → English (original_language = 'en')
//   All others → excluded UNLESS popularity >= GLOBAL_POP_THRESHOLD
//                (covers Avatar / Avengers / Mission Impossible scale events only)
//
// QUALITY GATES:
//   • poster_path must exist
//   • vote_count >= 50
//   • popularity  >= 20
//   • release_date within last ~3 months  (now_playing bypasses this gate)
//
// POOL: up to 30 movies, sorted Hindi-first → English-second → global,
//       and Now-Playing-first within each language tier.
//
// Cache: 15 min in-memory (CACHE_TTL).
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTrendingMovies() {
  const now = Date.now();
  if (_moviesCache.data?.length && now - _moviesCache.ts < CACHE_TTL) return _moviesCache.data;

  const KEY = process.env.TMDB_API_KEY;
  if (!KEY) {
    console.warn('[movies] TMDB_API_KEY not set — using fallback');
    return FALLBACK_MOVIES;
  }

  try {
    // Indian ISPs (like Jio) frequently block api.themoviedb.org.
    // api.tmdb.org is an official alternative domain that bypasses this block.
    const BASE = process.env.TMDB_BASE_URL || 'https://api.tmdb.org/3';

    // ── Parallel fetch from FIVE TMDB sources ────────────────────────────
    // Sources 1+2: now_playing India pages 1 & 2 (confirmed theatrical content)
    // Source 3: popular Hindi-only (with_original_language=hi) — boosts Hindi pool
    // Source 4: popular India (all langs, filtered downstream to hi/en)
    // Source 5: global trending — catches mega-blockbusters (Avatar, Avengers…)
    const [np1Settled, np2Settled, hindiPopSettled, popularSettled, trendingSettled] = await Promise.allSettled([
      fetch(`${BASE}/movie/now_playing?${new URLSearchParams({ api_key: KEY, region: 'IN', language: 'en-US', page: '1' })}`),
      fetch(`${BASE}/movie/now_playing?${new URLSearchParams({ api_key: KEY, region: 'IN', language: 'en-US', page: '2' })}`),
      fetch(`${BASE}/movie/popular?${new URLSearchParams(    { api_key: KEY, region: 'IN', language: 'en-US', page: '1', with_original_language: 'hi' })}`),
      fetch(`${BASE}/movie/popular?${new URLSearchParams(    { api_key: KEY, region: 'IN', language: 'en-US', page: '1' })}`),
      fetch(`${BASE}/trending/movie/week?${new URLSearchParams({ api_key: KEY, language: 'en-US' })}`),
    ]);

    // ── Parse each settled promise — failures yield empty arrays ──────────
    const parseSettled = async (settled, src) => {
      if (settled.status !== 'fulfilled') {
        console.warn(`[movies] ${src} fetch rejected: ${settled.reason?.message}`);
        return [];
      }
      if (!settled.value.ok) {
        console.warn(`[movies] ${src} HTTP ${settled.value.status}`);
        return [];
      }
      const data = await settled.value.json();
      return (data.results || []).map(m => ({ ...m, _src: src }));
    };

    const [np1Raw, np2Raw, hindiPopRaw, popularRaw, trendingRaw] = await Promise.all([
      parseSettled(np1Settled,       'now_playing'),
      parseSettled(np2Settled,       'now_playing'),  // same _src tag → same source priority
      parseSettled(hindiPopSettled,  'popular'),       // Hindi-only popular → same tier as general popular
      parseSettled(popularSettled,   'popular'),
      parseSettled(trendingSettled,  'trending'),
    ]);

    // Merge both now_playing pages into a single list
    const nowPlayingRaw = [...np1Raw, ...np2Raw];

    console.log(`[movies] raw — nowPlaying:${nowPlayingRaw.length} hindiPop:${hindiPopRaw.length} popular:${popularRaw.length} trending:${trendingRaw.length}`);

    // ── Merge with source-priority dedup ──────────────────────────────────
    // Priority order: now_playing > hindiPop > popular > trending
    // Hindi popular is placed before general popular so Hindi movies win dedup
    // when they appear in both lists (ensures _src stays 'popular' for both,
    // but the dedicated Hindi source runs first so its richer metadata wins).
    const seen   = new Set();
    const merged = [...nowPlayingRaw, ...hindiPopRaw, ...popularRaw, ...trendingRaw].filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    // ── Recency gate ──────────────────────────────────────────────────────
    // Movies more than ~3 months old are unlikely to still be in theatres.
    // now_playing bypasses this gate because TMDB guarantees they're playing.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 3);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

    // ── Global popularity exception threshold ─────────────────────────────
    // Only truly mega-blockbusters (Avatar / Avengers / Mission Impossible scale)
    // pass the Hindi/English language gate as exceptions. Set high intentionally —
    // this exception should be rare and cover only globally dominant films.
    const GLOBAL_POP_THRESHOLD = 200;

    // ── India + Language filter ───────────────────────────────────────────
    const filtered = merged.filter(m => {
      if (!m.poster_path)               return false; // no poster → broken UI card
      if ((m.vote_count  || 0) < 50)    return false; // too few votes → unreliable
      if ((m.popularity  || 0) < 20)    return false; // too niche for Indian screens

      // Recency: now_playing bypasses; popular/trending must be within 3-month window
      if (m._src !== 'now_playing' && m.release_date && m.release_date < cutoffStr) return false;

      // Language gate — Hindi first, English second
      const lang = m.original_language;
      if (lang === 'hi' || lang === 'en') return true;

      // Global exception: only mega-blockbusters regardless of language
      return (m.popularity || 0) >= GLOBAL_POP_THRESHOLD;
    });

    if (!filtered.length) throw new Error('0 movies after India/language filter');

    // ── Priority sort ─────────────────────────────────────────────────────
    //  0 — Hindi   + now_playing  (current Hindi theatrical releases in IN)
    //  1 — Hindi   + popular / trending
    //  2 — English + now_playing  (current English theatrical releases in IN)
    //  3 — English + popular / trending
    //  4 — Global exception (very high popularity, non-HI/EN)
    const _srcPriority = (m) => {
      const hi = m.original_language === 'hi';
      const en = m.original_language === 'en';
      const np = m._src === 'now_playing';
      if (hi && np) return 0;
      if (hi)       return 1;
      if (en && np) return 2;
      if (en)       return 3;
      return 4;
    };

    filtered.sort((a, b) => {
      const diff = _srcPriority(a) - _srcPriority(b);
      if (diff !== 0) return diff;
      return (b.popularity || 0) - (a.popularity || 0); // within tier: most popular first
    });

    // ── Build pool of up to 30 movies ─────────────────────────────────────
    const pool = filtered.slice(0, 30).map(m => ({
      id:         m.id,
      title:      m.title,
      posterPath: m.poster_path || null,
      rating:     Math.round((m.vote_average || 0) * 10) / 10,
      language:   m.original_language,  // 'hi' | 'en' | other — used by generateSystemSessions
      source:     m._src,               // 'now_playing' | 'popular' | 'trending'
      popularity: m.popularity || 0,
    }));

    _moviesCache = { data: pool, ts: now };

    const hiCount = pool.filter(m => m.language === 'hi').length;
    const enCount = pool.filter(m => m.language === 'en').length;
    const npCount = pool.filter(m => m.source  === 'now_playing').length;
    console.log(`[movies] pool: ${pool.length} total | Hindi:${hiCount} English:${enCount} NowPlaying:${npCount}`);

    return pool;
  } catch (err) {
    console.warn(`[movies] TMDB failed (${err.message}) — fallback`);
    return _moviesCache.data?.length ? _moviesCache.data : FALLBACK_MOVIES;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchNearbyTheatres — Google Places API v1 (POST, not GET)
// Filter: rating >= 3.0, top 5 only
// Sort: distance ASC, then rating DESC
// ─────────────────────────────────────────────────────────────────────────────
async function fetchNearbyTheatres(lat, lng, radius = 8000) {
  if (lat === null || lng === null) return _buildFallbackTheatres(0, 0);

  const KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!KEY) {
    console.warn('[theatres] GOOGLE_PLACES_API_KEY not set — fallback');
    return _buildFallbackTheatres(lat, lng);
  }

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.location',
      },
      body: JSON.stringify({
        includedTypes: ['movie_theater'],
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: parseFloat(radius),
          },
        },
      }),
    });

    if (!res.ok) throw new Error(`Places API HTTP ${res.status}`);
    const data = await res.json();
    const places = data.places || [];

    const list = places
      .map(p => ({
        placeId:  p.id || '',
        name:     p.displayName?.text   || 'Cinema',
        address:  p.formattedAddress    || '',
        rating:   p.rating              || null,
        lat:      p.location?.latitude  || 0,
        lng:      p.location?.longitude || 0,
        distance: Math.round(_haversine(lat, lng, p.location?.latitude || 0, p.location?.longitude || 0)),
      }))
      // ── Filter: rating >= 3.0 (spec requirement) ──────────────────────────
      .filter(t => t.rating === null || t.rating >= 3.0)
      // ── Sort: distance ASC, rating DESC ───────────────────────────────────
      .sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return (b.rating || 0) - (a.rating || 0);
      })
      // ── Top 5 only (spec requirement) ─────────────────────────────────────
      .slice(0, 5);

    if (!list.length) {
      console.warn('[theatres] 0 results after filter — fallback');
      return _buildFallbackTheatres(lat, lng);
    }

    console.log(`[theatres] Places API v1: ${list.length} cinema(s)`);
    return list;
  } catch (err) {
    console.warn(`[theatres] Places failed (${err.message}) — fallback`);
    return _buildFallbackTheatres(lat, lng);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// searchTheatres — Google Places Text Search API v1
// Ignores distance limit — lets user find any cinema by name
// Returns max 10 results (not filtered to top 5)
// ─────────────────────────────────────────────────────────────────────────────
async function searchTheatres(query, lat = null, lng = null) {
  const KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!KEY) return { success: false, theatres: [], message: 'Search unavailable' };
  if (!query?.trim()) return { success: false, theatres: [], message: 'Query required' };

  try {
    const body = {
      textQuery:    `${query.trim()} cinema movie theatre`,
      includedType: 'movie_theater',
      maxResultCount: 10,
    };

    // Bias results towards user's location if available
    if (lat !== null && lng !== null) {
      body.locationBias = {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: 50000,
        },
      };
    }

    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.location',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Places Text Search HTTP ${res.status}`);
    const data  = await res.json();
    const places = data.places || [];

    const theatres = places.map(p => ({
      placeId:  p.id || '',
      name:     p.displayName?.text   || 'Cinema',
      address:  p.formattedAddress    || '',
      rating:   p.rating              || null,
      lat:      p.location?.latitude  || 0,
      lng:      p.location?.longitude || 0,
      distance: (lat !== null && lng !== null)
        ? Math.round(_haversine(lat, lng, p.location?.latitude || 0, p.location?.longitude || 0))
        : null,
    }));

    return { success: true, theatres, source: 'search' };
  } catch (err) {
    console.error(`[theatres/search] error: ${err.message}`);
    return { success: false, theatres: [], message: 'Search failed' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM_SHOW_TIMES — fixed daily schedule for auto-generated sessions
//   11 AM · 3 PM · 7 PM  (IST)
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_SHOW_TIMES = [
  { hour: 11, minute: 0, label: '11 AM' },
  { hour: 15, minute: 0, label: '3 PM'  },
  { hour: 19, minute: 0, label: '7 PM'  },
];

// ─────────────────────────────────────────────────────────────────────────────
// _istNow() — current time as IST Date object
// ─────────────────────────────────────────────────────────────────────────────
function _istNow() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(Date.now() + IST_OFFSET_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// _buildShowTimeUTC(istDateStr, hourIST, minuteIST)
//
// Given an IST date string (YYYY-MM-DD) and slot hour/minute in IST,
// returns the correct UTC Date for that moment.
// 11 AM IST = 05:30 UTC  |  3 PM IST = 09:30 UTC  |  7 PM IST = 13:30 UTC
// ─────────────────────────────────────────────────────────────────────────────
function _buildShowTimeUTC(istDateStr, hourIST, minuteIST) {
  const [y, mo, d] = istDateStr.split('-').map(Number);
  // IST - 5:30 = UTC
  const utcMinutes = hourIST * 60 + minuteIST - 330; // 330 = 5*60+30
  const utcHour    = Math.floor(utcMinutes / 60);
  const utcMin     = utcMinutes % 60;
  // Handle day boundary (e.g. 11 AM IST = 05:30 UTC, same day)
  return new Date(Date.UTC(y, mo - 1, d, utcHour, utcMin, 0, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// generateSystemSessions(userCtx, lat, lng)
//
// Slot-fill logic — per updated spec:
//
//  BEFORE 7 PM IST:
//    Target = TODAY. Only generate slots that are still in the future.
//    (e.g. at 2 PM IST, only create 3 PM + 7 PM slots if missing)
//
//  AT/AFTER 7 PM IST:
//    Target = TOMORROW. Generate all 3 slots for tomorrow if missing.
//
// Rules:
//  • participants = [] always — NEVER fake users
//  • adminId = null — first real joiner gets assigned atomically
//  • Diversity: different movie per slot
//  • Duplicate guard: skip if same movie+city+date+time already active
//  • Max 3 system sessions total across all slots — enforced by slot-fill logic
//  • Returns count of sessions created
//
// Language per slot: derived from movie.language via _LANG_DISPLAY.
//   hi → 'Hindi'  |  en → 'English'  |  other → userLang → DEFAULT_LANGUAGE
//   Tamil and other regional languages are excluded upstream in fetchTrendingMovies().
// ─────────────────────────────────────────────────────────────────────────────
async function generateSystemSessions(userCtx, lat, lng) {
  const nowIST  = _istNow();
  const istHour = nowIST.getUTCHours();

  // Determine target day: before 7 PM IST → today, else → tomorrow
  const AFTER_7PM = istHour >= 19;
  let targetIST;
  if (AFTER_7PM) {
    targetIST = new Date(nowIST.getTime() + 24 * 60 * 60 * 1000);
  } else {
    targetIST = nowIST;
  }
  const targetDateStr = targetIST.toISOString().slice(0, 10); // YYYY-MM-DD in IST

  console.log(`\n🤖 generateSystemSessions START`);
  console.log(`   IST hour=${istHour}, target=${AFTER_7PM ? 'TOMORROW' : 'TODAY'} (${targetDateStr})`);
  console.log(`   lat=${lat}, lng=${lng}, lang=${userCtx?.languagePreference}, city=${userCtx?.city}`);

  const [movies, theatres] = await Promise.all([
    fetchTrendingMovies(),
    fetchNearbyTheatres(lat, lng),
  ]);

  console.log(`   movies=${movies.length}, theatres=${theatres.length}`);

  const userLang = userCtx?.languagePreference || DEFAULT_LANGUAGE;
  const city     = (userCtx?.city || '').trim().toLowerCase();
  let   created  = 0;

  // Collect already-used slots + movies for target date near these coordinates.
  // We intentionally do NOT filter by city here — city is unreliable user profile
  // data that causes duplicate sessions for the same physical theatre.
  // Instead, use geo proximity to find sessions near these coords.
  const existingQuery = {
    status: 'active',
    date:   targetDateStr,
  };
  let existingSessions = [];
  if (lat !== null && lng !== null) {
    try {
      existingSessions = await MovieSession.find({
        ...existingQuery,
        location: {
          $nearSphere: {
            $geometry:    { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: MAX_RADIUS_M,
          },
        },
      }).select('movieId time theatrePlaceId isSystemGenerated').lean();
    } catch (_) {
      // geo index not ready — fall back to bare date query
      existingSessions = await MovieSession.find(existingQuery)
        .select('movieId time theatrePlaceId isSystemGenerated').lean();
    }
  } else {
    existingSessions = await MovieSession.find(existingQuery)
      .select('movieId time theatrePlaceId isSystemGenerated').lean();
  }

  // Count existing system sessions for this date near user (max 3 allowed)
  const existingSystemCount = existingSessions.filter(s => s.isSystemGenerated).length;
  if (existingSystemCount >= 3) {
    console.log(`   ⚠️ already ${existingSystemCount} system sessions for ${targetDateStr} — skipping`);
    return 0;
  }

  const existingSlotTimes    = new Set(existingSessions.map(s => s.time));
  const existingPlaceIdSlots = new Set(existingSessions.map(s => `${s.theatrePlaceId}|${s.time}`));
  const usedMovieIds         = new Set(existingSessions.map(s => s.movieId));

  console.log(`   existing: ${existingSessions.length} session(s), slots taken: ${[...existingSlotTimes].join(', ')}`);

  // ── Build movie pool with LANGUAGE-PRIORITY shuffle ───────────────────────
  //
  // ROOT CAUSE OF ENGLISH SESSIONS:
  //   A flat _shuffle() on the full movie list destroys the Hindi-first ordering
  //   that fetchTrendingMovies() produces. English movies end up at random positions
  //   0, 1, or 2 — the exact indices picked for the 3 daily time slots.
  //
  // FIX:
  //   Use _buildLangPriorityPool() which shuffles WITHIN each language bucket,
  //   then concatenates Hindi → English → other. This guarantees all Hindi movies
  //   appear before any English movie in the final pool, so slot picks are always
  //   Hindi-first by construction, not by chance.
  //
  // Exclusion tiers (unchanged):
  //   Tier 1: not used today AND not recently used by system
  //   Tier 2: not used today (relax recent-use exclusion if pool < 3)
  //   Tier 3: full pool (last resort, all exclusions dropped)
  const recentIds = _getRecentMovieIds();

  // Tier 1: not used today AND not recently used by system
  const tier1 = movies.filter(m => !usedMovieIds.has(String(m.id)) && !recentIds.has(String(m.id)));
  let moviePool = _buildLangPriorityPool(tier1);

  // Tier 2: fall back — allow recently-used movies if pool is too small
  if (moviePool.length < 3) {
    console.log(`   [pool] tier-1 pool too small (${moviePool.length}) — relaxing recent-use exclusion`);
    const tier2 = movies.filter(m => !usedMovieIds.has(String(m.id)));
    moviePool = _buildLangPriorityPool(tier2);
  }

  // Tier 3: all movies (shouldn't happen in practice with 20+ TMDB results)
  if (moviePool.length === 0) {
    console.log(`   [pool] all movies used today — using full priority pool`);
    moviePool = _buildLangPriorityPool([...movies]);
  }

  const poolHi = moviePool.filter(m => m.language === 'hi').length;
  const poolEn = moviePool.filter(m => m.language === 'en').length;
  console.log(`   [pool] ${moviePool.length} movie(s) available | Hindi:${poolHi} English:${poolEn}`);

  let movieIdx = 0;

  for (let i = 0; i < SYSTEM_SHOW_TIMES.length; i++) {
    const slot    = SYSTEM_SHOW_TIMES[i];
    const timeStr = `${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`;

    // For TODAY: skip slots that are already in the past (IST)
    if (!AFTER_7PM) {
      const slotTotalMinutesIST = slot.hour * 60 + slot.minute;
      const nowTotalMinutesIST  = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
      if (slotTotalMinutesIST <= nowTotalMinutesIST) {
        console.log(`   [${slot.label}] skip — already past in IST`);
        continue;
      }
    }

    // Skip if slot already has a session (user or system)
    if (existingSlotTimes.has(timeStr)) {
      console.log(`   [${slot.label}] skip — slot already filled`);
      continue;
    }

    if (movieIdx >= moviePool.length) {
      console.log(`   [${slot.label}] skip — no more distinct movies available`);
      continue;
    }

    const movie   = moviePool[movieIdx++];
    const theatre = theatres[i % theatres.length];

    // ── Derive session display language from the movie's own language code ──
    // hi → Hindi, en → English, anything else → userLang → DEFAULT_LANGUAGE.
    // This ensures the session language always reflects the actual film being shown.
    // Tamil and other regional languages are excluded upstream in fetchTrendingMovies()
    // so in practice this resolves to either 'Hindi' or 'English' for every slot.
    const lang = _LANG_DISPLAY[movie.language] || userLang || DEFAULT_LANGUAGE;

    // Build correct UTC showTime from IST date + slot
    const showTime  = _buildShowTimeUTC(targetDateStr, slot.hour, slot.minute);
    const expiresAt = new Date(showTime.getTime() +  15 * 60_000);
    const chatExpAt = new Date(showTime.getTime() + 180 * 60_000);

    console.log(`   [${slot.label}] "${movie.title}" (${movie.language}→${lang}) @ "${theatre.name}" showTime=${showTime.toISOString()}`);

    // Final duplicate guard — use theatrePlaceId+date+time as the unique key.
    // city is NOT used here because it comes from user.questionnaire.city which
    // can be wrong (e.g. "north delhi" for a Bhilai theatre). Two different users
    // with different home cities would otherwise create duplicate sessions for the
    // exact same physical theatre at the exact same time.
    const placeIdSlotKey = `${theatre.placeId}|${timeStr}`;
    if (theatre.placeId && existingPlaceIdSlots.has(placeIdSlotKey)) {
      console.log(`   [${slot.label}] skip — placeId+time slot already filled (dedup)`);
      continue;
    }
    const dupExists = await MovieSession.exists({
      theatrePlaceId: theatre.placeId || null,
      date:           targetDateStr,
      time:           timeStr,
      status:         'active',
    });
    if (dupExists) {
      console.log(`   [${slot.label}] skip — exact duplicate found`);
      continue;
    }

    try {
      const session = await MovieSession.create({
        movieId:           movie.id.toString(),
        movieTitle:        movie.title,
        poster:            movie.posterPath || null,
        language:          lang,
        city,
        theatreName:       theatre.name,
        theatreAddress:    theatre.address || 'Nearby Cinema',
        theatrePlaceId:    theatre.placeId || null,
        location: {
          type:        'Point',
          coordinates: [parseFloat(theatre.lng), parseFloat(theatre.lat)],
        },
        date:              targetDateStr,
        time:              timeStr,
        showTime,
        expiresAt,
        chatExpiresAt:     chatExpAt,
        createdBy:         'system',
        participants:      [],
        adminId:           null,
        maxParticipants:   4,
        isBoosted:         false,
        isSystemGenerated: true,
        status:            'active',
        chatId:            null,
      });
      console.log(`   [${slot.label}] ✅ session ${session._id}`);

      try {
        const chat = await MovieChat.create({
          sessionId:    session._id,
          participants: [],
          messages:     [],
          expiresAt:    chatExpAt,
          status:       'active',
        });
        session.chatId = chat._id;
        await session.save();
      } catch (chatErr) {
        console.warn(`   [${slot.label}] ⚠️ chat failed: ${chatErr.message}`);
      }

      usedMovieIds.add(String(movie.id));
      _markMovieUsed(movie.id);  // update rotation cache
      created++;
    } catch (err) {
      console.error(`   [${slot.label}] ❌ ${err.message}`);
    }
  }

  console.log(`🤖 generateSystemSessions END — ${created} slot(s) filled\n`);
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// countNearbyRealUserSessions(loc, city)
// City-aware count of active real-user sessions. Used by STEP 2 + daily job.
// ─────────────────────────────────────────────────────────────────────────────
async function countNearbyRealUserSessions(loc, city) {
  const now = new Date();
  const baseQuery = {
    status:            'active',
    expiresAt:         { $gt: now },
    isSystemGenerated: false,
    ...(city ? { city: city.trim().toLowerCase() } : {}),
  };

  if (loc && loc.lat !== null && loc.lng !== null) {
    try {
      return await MovieSession.countDocuments({
        ...baseQuery,
        location: {
          $nearSphere: {
            $geometry:    { type: 'Point', coordinates: [loc.lng, loc.lat] },
            $maxDistance: 20_000,
          },
        },
      });
    } catch (_) { /* geo index not ready */ }
  }
  return MovieSession.countDocuments(baseQuery);
}

// getMovies — public API response
async function getMovies() {
  const movies = await fetchTrendingMovies();
  return { success: true, movies };
}

// ─────────────────────────────────────────────────────────────────────────────
// getNearbyTheatres — top 5, rating >= 3.0
// ─────────────────────────────────────────────────────────────────────────────
async function getNearbyTheatres(userId, queryLat, queryLng, radius = 8000) {
  const loc = await _resolveLocation(queryLat, queryLng, userId);

  if (loc.lat === null || loc.lng === null) {
    return { success: false, message: 'Location unavailable. Please enable location in settings.' };
  }

  console.log(`[theatres] ${loc.source} loc: (${loc.lat}, ${loc.lng})`);
  const theatres = await fetchNearbyTheatres(loc.lat, loc.lng, parseInt(radius));
  return { success: true, locationSource: loc.source, theatres };
}

// ─────────────────────────────────────────────────────────────────────────────
// getNearbySessions
//
// STRICT 4-STEP FLOW (per spec):
//  STEP 1 — Fetch sessions from DB (within 20 km)
//  STEP 2 — If sessions < 2 → generateSystemSessions()
//  STEP 3 — RE-FETCH sessions from DB
//  STEP 4 — Sort (lang → boosted → dist → time → participants) → top 5
// ─────────────────────────────────────────────────────────────────────────────
async function getNearbySessions(userId, queryLat, queryLng) {
  const now = new Date();

  const [loc, userCtx] = await Promise.all([
    _resolveLocation(queryLat, queryLng, userId),
    _fetchUserContext(userId),
  ]);

  const userLang = userCtx?.languagePreference || DEFAULT_LANGUAGE;
  const userCity = (userCtx?.city || '').trim().toLowerCase();
  console.log(`\n📡 getNearbySessions — lang="${userLang}" city="${userCity}" loc=(${loc.lat},${loc.lng}) via ${loc.source}`);

  // City-scoped base query — NEVER show cross-city sessions
  // expiresAt > now ensures past-slot sessions (e.g. 11 AM at 2 PM) are excluded.
  // showTime > now is an additional guard so sessions whose slot hasn't started yet
  // but whose expiresAt is in the future don't accidentally surface.
  // IMPORTANT: do NOT filter by city in the base query.
  // City is user.questionnaire.city — it can be wrong or stale (e.g. a Bhilai user
  // with city="north delhi" in profile). Geo distance via $nearSphere is the correct
  // isolation mechanism. Sessions far away are naturally excluded by the 20 km radius.
  const baseQuery = {
    status:    'active',
    expiresAt: { $gt: now },
    showTime:  { $gt: new Date(now.getTime() - 15 * 60_000) }, // allow up to 15 min grace
  };

  // STEP 1
  let sessions = await _fetchSessionsFromDB(loc, baseQuery);
  console.log(`STEP 1: ${sessions.length} session(s)`);

  // STEP 2 — Generate system sessions only when real-user sessions <= 1
  // (spec: "If real user sessions <= 1 → create 3 system sessions")
  const realUserCount = sessions.filter(s => !s.isSystemGenerated).length;
  console.log(`STEP 1 detail: ${realUserCount} real-user, ${sessions.length - realUserCount} system`);

  if (realUserCount < 3) {
    console.log('STEP 2: real sessions sparse → generateSystemSessions()');
    const genLat = loc.lat ?? userCtx?.lat ?? null;
    const genLng = loc.lng ?? userCtx?.lng ?? null;

    if (genLat !== null && genLng !== null) {
      await generateSystemSessions(
        { languagePreference: userLang, city: userCity },
        genLat, genLng
      );
    } else {
      console.warn('STEP 2: no coordinates — cannot generate');
    }

    // STEP 3 — re-fetch
    sessions = await _fetchSessionsFromDB(loc, baseQuery);
    console.log(`STEP 3: ${sessions.length} session(s) after generation`);
  } else {
    console.log('STEP 2: enough real sessions — skipping generation');
  }

  // STEP 4 — Score, sort, cap at 5 visible
  //
  // Sort priority (per spec):
  //   1. Real-user sessions first  (score +200)
  //   2. More real participants     (score +10 each, max +40)
  //   3. Earlier show time         (score +2 to +20)
  //   4. Language match + boosted  (score bonus)
  //
  // Fill strategy:
  //   Take all real-user sessions (up to 5), fill remainder with system sessions
  //   until total = 5. Real users always dominate.

  const scored = sessions.map(s => {
    const distM = (loc.lat !== null && s.location?.coordinates)
      ? _haversine(loc.lat, loc.lng, s.location.coordinates[1], s.location.coordinates[0])
      : null;
    return {
      formatted: _formatSession(s, userId, distM),
      score:     _scoreSession(s, now, userLang, loc.lat, loc.lng),
      isSystem:  s.isSystemGenerated || false,
    };
  });

  // Split into buckets
  const realSessions   = scored.filter(x => !x.isSystem).sort((a, b) => b.score - a.score);
  const systemSessions = scored.filter(x =>  x.isSystem).sort((a, b) => b.score - a.score);

  // Display cap: max 5 sessions visible
  // System generates 3 sessions (11AM, 3PM, 7PM) + up to 2 real-user sessions
  // can stack on top → total 5. If no real-user sessions: 3 system shown.
  const MAX_VISIBLE = 5;
  const combined = [
    ...realSessions.slice(0, MAX_VISIBLE),
    ...systemSessions.slice(0, Math.max(0, MAX_VISIBLE - realSessions.length)),
  ].slice(0, MAX_VISIBLE);

  const result = combined.map(x => x.formatted);

  console.log(`STEP 4: ${realSessions.length} real + ${systemSessions.length} system → returning ${result.length}\n`);

  return { success: true, userLanguage: userLang, sessions: result };
}

// ─────────────────────────────────────────────────────────────────────────────
// createSession — user-created session
// Language fetched from profile (NEVER from frontend)
// Chat auto-message: "{name} created this hangout 🎬"
// ─────────────────────────────────────────────────────────────────────────────
async function createSession(userId, data) {
  const {
    movieId, title, posterPath, theatreName, theatreAddress,
    theatrePlaceId, theatreLat, theatreLng, date, time, maxParticipants, isUrgent,
  } = data;

  if (!movieId || !title || !theatreName || !theatreAddress || !date || !time) {
    return { success: false, status: 400, message: 'Missing required fields' };
  }
  if (!theatreLat || !theatreLng) {
    return { success: false, status: 400, message: 'Theatre location required' };
  }

  // Language + city from profile — never from client
  const userCtx  = await _fetchUserContext(userId);
  const language = userCtx?.languagePreference || DEFAULT_LANGUAGE;
  const city     = (userCtx?.city || '').trim().toLowerCase();

  // ── VERIFIED USER GATE ────────────────────────────────────────────────────
  if (!userCtx?.isVerified) {
    return {
      success: false,
      status:  403,
      code:    'VERIFICATION_REQUIRED',
      message: 'Only verified users can create a Movie Hangout. Complete your profile verification to continue.',
    };
  }

  console.log(`[create] lang="${language}" city="${city}"`);

  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi]    = time.split(':').map(Number);
  // IMPORTANT: date and time from the frontend are in IST.
  // new Date(y, mo-1, d, h, mi) uses server local time — UTC on Render.
  // We must build the UTC Date that corresponds to the IST slot.
  // IST = UTC + 5:30, so UTC = IST - 5:30 = subtract 330 minutes.
  const utcMinutes = h * 60 + mi - 330; // 330 = 5*60+30
  const utcHour    = Math.floor(utcMinutes / 60);
  const utcMin     = utcMinutes % 60;
  const showTime   = new Date(Date.UTC(y, mo - 1, d, utcHour, utcMin, 0, 0));

  // ── Time rules: 9 AM–8 PM window + 7:30 PM creation cutoff ─────────────
  // validateShowTime() checks future + 9 AM–8 PM bounds
  const timeCheck = validateShowTime(showTime);
  if (!timeCheck.valid) {
    return { success: false, status: 400, message: timeCheck.reason };
  }

  // Creation cutoff removed — slot validation in validateShowTime() is the only gate now.

  const expiresAt = new Date(showTime.getTime() +  15 * 60_000);
  const chatExpAt = new Date(showTime.getTime() + 180 * 60_000);

  // ── JOIN-FIRST CHECK ─────────────────────────────────────────────────────
  // Before creating, search for an existing active session with:
  //   • same movieId
  //   • same city
  //   • showTime within ±30 minutes of the requested showTime
  //   • not full
  //
  // NOTE: theatrePlaceId is intentionally NOT used as a match key.
  //   Different users may pick different theatre objects for the same physical
  //   cinema (fallback IDs vs real Places IDs). Using only movieId+city+time
  //   window gives the correct "same hangout" signal.
  //
  // If found AND not full → return a join-nudge response instead of creating.
  // If full OR no match → fall through to duplicate guard then creation.
  const THIRTY_MIN_MS = 30 * 60 * 1000;
  const windowStart   = new Date(showTime.getTime() - THIRTY_MIN_MS);
  const windowEnd     = new Date(showTime.getTime() + THIRTY_MIN_MS);

  const joinCandidates = await MovieSession.find({
    movieId:   movieId.toString(),
    city,
    status:    'active',
    expiresAt: { $gt: new Date() },
    showTime:  { $gte: windowStart, $lte: windowEnd },
  })
    .populate('participants', 'firstName')
    .lean();

  // Pick the best match: not full, most participants first
  const joinCandidate = joinCandidates
    .filter(s => s.participants.length < s.maxParticipants)
    .sort((a, b) => b.participants.length - a.participants.length)[0] || null;

  if (joinCandidate) {
    console.log(`[create] join-first: found session ${joinCandidate._id} with ${joinCandidate.participants.length} participant(s)`);
    return {
      success: true,
      status:  200,
      action:  'join',
      message: 'A hangout is already happening nearby. Join instead.',
      // Key is 'joinInfo' NOT 'session' to avoid Gson type collision on Android.
      // Android's MovieSession model maps participants as List<Participant> (array),
      // but here participants is an Int count. Using a separate key prevents the crash.
      joinInfo: {
        sessionId:       joinCandidate._id.toString(),
        movieTitle:      joinCandidate.movieTitle,
        theatreName:     joinCandidate.theatreName,
        showTime:        joinCandidate.showTime?.toISOString() || null,
        date:            joinCandidate.date,
        time:            joinCandidate.time,
        participants:    joinCandidate.participants.length,
        maxParticipants: joinCandidate.maxParticipants,
        chatId:          joinCandidate.chatId?.toString() || null,
      },
    };
  }

  // Duplicate guard — (movieId + city + date + time) per spec
  const dup = await MovieSession.findOne({
    movieId:  movieId.toString(),
    city,
    date,
    time,
    status:   'active',
  });
  if (dup) return { success: false, status: 409, message: 'A session for this movie at this time already exists in your city.' };

  // Create session — creator is first (and only initial) participant
  const session = await MovieSession.create({
    movieId:           movieId.toString(),
    movieTitle:        title,
    poster:            posterPath || null,
    language,
    city,
    theatreName,
    theatreAddress,
    theatrePlaceId:    theatrePlaceId || null,
    location: {
      type:        'Point',
      coordinates: [parseFloat(theatreLng), parseFloat(theatreLat)],
    },
    date, time, showTime, expiresAt, chatExpiresAt: chatExpAt,
    createdBy:         userId,
    participants:      [userId],
    adminId:           userId,   // creator is always admin of their own session
    maxParticipants:   parseInt(maxParticipants) || 5,
    isBoosted:         Boolean(isUrgent),
    isSystemGenerated: false,
    status:            'active',
    chatId:            null,
  });

  // Create chat
  const chat = await MovieChat.create({
    sessionId:    session._id,
    participants: [userId],
    messages:     [],
    expiresAt:    chatExpAt,
    status:       'active',
  });

  // Auto-message: "{name} created this hangout 🎬"
  const creatorName = userCtx
    ? `${userCtx.firstName} ${userCtx.lastName || ''}`.trim()
    : 'Someone';
  await chat.addSystemMessage(`${creatorName} created this hangout 🎬`);

  session.chatId = chat._id;
  await session.save();

  const populated = await MovieSession.findById(session._id)
    .populate('participants', 'firstName lastName profilePhoto');

  return { success: true, status: 201, session: _formatSession(populated, userId) };
}

// ─────────────────────────────────────────────────────────────────────────────
// joinSession
//
// RULES:
//  1. No duplicate joins
//  2. No over-capacity
//  3. Atomic admin assignment: findOneAndUpdate({ adminId: null })
//  4. Add userId to participants
//  5. Chat message: "{name} joined the hangout"
//  6. If first joiner on system session: also send "You started this hangout 🎉"
// ─────────────────────────────────────────────────────────────────────────────
async function joinSession(userId, sessionId, io) {
  // ── VERIFIED USER GATE ────────────────────────────────────────────────────
  const joinerCtx = await _fetchUserContext(userId);
  if (!joinerCtx?.isVerified) {
    return {
      success: false,
      status:  403,
      code:    'VERIFICATION_REQUIRED',
      message: 'Only verified users can join a Movie Hangout. Complete your profile verification to continue.',
    };
  }

  const session = await MovieSession.findById(sessionId);
  if (!session) return { success: false, status: 404, message: 'Session not found' };

  if (session.status === 'expired' || new Date() > session.expiresAt) {
    return { success: false, status: 400, message: 'This session has expired' };
  }

  const alreadyIn = session.participants.some(p => p.toString() === userId.toString());
  if (alreadyIn) {
    return { success: true, message: 'Already a member', chatId: session.chatId?.toString() || null };
  }

  if (session.participants.length >= session.maxParticipants) {
    return { success: false, status: 400, message: 'Session is full' };
  }

  const isFirstJoin = session.participants.length === 0;

  // ── Atomic admin assignment — only if no admin yet ────────────────────────
  await MovieSession.findOneAndUpdate(
    { _id: sessionId, adminId: null },
    { $set: { adminId: userId } }
  );

  // ── Add to participants ───────────────────────────────────────────────────
  await MovieSession.findByIdAndUpdate(sessionId, {
    $addToSet: { participants: userId },
  });

  // ── Fetch user for display name ───────────────────────────────────────────
  const User   = mongoose.model('User');
  const joiner = await User.findById(userId).select('firstName lastName profilePhoto').lean();
  const name   = joiner ? `${joiner.firstName} ${joiner.lastName || ''}`.trim() : 'Someone';

  // ── Add to chat + auto-messages ───────────────────────────────────────────
  if (session.chatId) {
    const chat = await MovieChat.findById(session.chatId);
    if (chat) {
      // Add user to chat participants
      const inChat = chat.participants.some(p => p.toString() === userId.toString());
      if (!inChat) chat.participants.push(userId);

      // System session first join: special welcome message
      if (session.isSystemGenerated && isFirstJoin) {
        await chat.addSystemMessage('You started this hangout 🎉\nWaiting for others to join...');
      }

      // Standard join message
      await chat.addSystemMessage(`${name} joined the hangout`);
    }
  }

  // ── Socket event: notify creator ─────────────────────────────────────────
  try {
    const creatorStr = session.createdBy?.toString?.() || 'system';
    if (io && creatorStr !== 'system') {
      io.to(`user-${creatorStr}`).emit('movie-session-joined', {
        sessionId:   sessionId.toString(),
        joinerName:  name,
        movieTitle:  session.movieTitle,
        participants: session.participants.length + 1,
      });
    }
  } catch (_) { /* non-critical */ }

  return {
    success: true,
    message: 'Joined successfully',
    chatId:  session.chatId?.toString() || null,
    isAdmin: isFirstJoin, // client can show admin badge
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getSessionChat — member-only access (Paginated via MovieMessage)
// ─────────────────────────────────────────────────────────────────────────────
async function getSessionChat(userId, sessionId, page = 1, limit = 30) {
  const session = await MovieSession.findById(sessionId);
  if (!session) return { success: false, status: 404, message: 'Session not found' };

  const isMember = session.participants.some(p => p.toString() === userId.toString());
  if (!isMember) return { success: false, status: 403, message: 'You are not a member of this session' };

  const skip = (page - 1) * limit;
  const messages = await MovieMessage.find({ sessionId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  return {
    success: true,
    chat: {
      sessionId:    session._id.toString(),
      participants: session.participants.map(p => p.toString()),
      messages:     messages.reverse().map(m => ({
        id:          m._id.toString(),
        senderId:    m.senderId?.toString() || null,
        senderName:  m.senderName,
        senderPhoto: m.senderPhoto || null,
        text:        m.text,
        type:        m.type,
        voiceUrl:    m.voiceUrl || null,
        duration:    m.duration || 0,
        replyTo:     m.replyTo?.toString() || null,
        readBy:      (m.readBy || []).map(r => r.toString()),
        reactions:   (m.reactions || []).map(r => ({ userId: r.userId?.toString(), reaction: r.reaction })),
        isSystem:    m.type === 'system',
        timestamp:   m.createdAt.toISOString(),
      })),
      pinnedMessageId: session.pinnedMessageId?.toString() || null,
      expiresAt: session.chatExpiresAt.toISOString(),
      status:    session.status,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getSessionSummary
// ─────────────────────────────────────────────────────────────────────────────
async function getSessionSummary(userId, sessionId) {
  const session = await MovieSession.findById(sessionId);
  if (!session) return { success: false, status: 404, message: 'Session not found' };

  if (session.status !== 'expired') {
    return { success: false, status: 400, message: 'Session has not expired yet' };
  }

  const messagesCount = await MovieMessage.countDocuments({ sessionId });
  
  // Aggregate to find most active user
  const mostActiveAggr = await MovieMessage.aggregate([
    { $match: { sessionId: session._id, type: { $ne: 'system' } } },
    { $group: { _id: '$senderId', count: { $sum: 1 }, name: { $first: '$senderName' } } },
    { $sort: { count: -1 } },
    { $limit: 1 }
  ]);
  
  const mostActiveUser = mostActiveAggr.length > 0 ? mostActiveAggr[0].name : 'N/A';
  
  // Calculate average rating
  let avgRating = 0;
  if (session.ratings && session.ratings.length > 0) {
    const sum = session.ratings.reduce((acc, r) => acc + r.rating, 0);
    avgRating = sum / session.ratings.length;
  }

  return {
    success: true,
    summary: {
      messagesCount,
      participantsCount: session.participants.length,
      mostActiveUser,
      averageRating: avgRating > 0 ? avgRating.toFixed(1) : 'N/A'
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sendMessage (HTTP Fallback)
// ─────────────────────────────────────────────────────────────────────────────
async function sendMessage(userId, sessionId, text, io) {
  if (!text?.trim()) return { success: false, status: 400, message: 'Message text required' };

  const { handleSocketMessage } = require('./movieHangoutService');
  await handleSocketMessage(userId, sessionId, text, null, io);

  return { success: true, message: 'Sent' };
}

// ─────────────────────────────────────────────────────────────────────────────
// sendPostSessionNotifications
// Called by expiry job when showTime + 15 min passes.
//
// Sends FCM push + (optionally) activity feed entry.
// Messages per spec:
//  1  participant  → "Your hangout didn't get any joins this time. Try again later."
//  <=2 participants → "Only a few people joined this time. Try again with a different time."
//  >=3 participants → "Your hangout was active 🎉 Hope you had a great time!"
// ─────────────────────────────────────────────────────────────────────────────
async function sendPostSessionNotifications(session) {
  // Only for user-created sessions
  const creatorStr = session.createdBy?.toString?.() || 'system';
  if (creatorStr === 'system') return;
  if (session.postSessionNotified) return;

  const count   = session.participants.length;
  const message = getPostSessionMessage(count);

  try {
    const User    = mongoose.model('User');
    const creator = await User.findById(creatorStr).select('fcmTokens firstName').lean();
    if (!creator) return;

    // ── FCM push notification ─────────────────────────────────────────────────
    const { tokens } = { tokens: creator.fcmTokens || [] };
    if (tokens.length > 0) {
      try {
        const { messaging } = require('../config/firebase');
        await messaging().sendEachForMulticast({
          tokens,
          notification: {
            title: '🎬 Movie Hangout Update',
            body:  message,
          },
          data: {
            type:      'MOVIE_SESSION_EXPIRED',
            sessionId: session._id.toString(),
          },
          android: { priority: 'normal' },
        });
        console.log(`[notify] FCM sent to ${creatorStr}: "${message}"`);
      } catch (fcmErr) {
        console.warn(`[notify] FCM failed: ${fcmErr.message}`);
      }
    }

    // ── Mark as notified ──────────────────────────────────────────────────────
    await MovieSession.findByIdAndUpdate(session._id, { postSessionNotified: true });

  } catch (err) {
    console.error(`[notify] post-session error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// debugSessions — no filters, raw DB dump (remove after confirming flow)
// ─────────────────────────────────────────────────────────────────────────────
async function debugSessions() {
  const total  = await MovieSession.countDocuments({});
  const active = await MovieSession.countDocuments({ status: 'active' });
  const rows   = await MovieSession.find({}).sort({ createdAt: -1 }).limit(10).lean();
  return {
    success: true, debug: true, totalCount: total, activeCount: active,
    sessions: rows.map(s => ({
      id:                s._id,
      movieTitle:        s.movieTitle,
      theatreName:       s.theatreName,
      language:          s.language,
      status:            s.status,
      isSystemGenerated: s.isSystemGenerated,
      participants:      s.participants.length,
      adminId:           s.adminId,
      showTime:          s.showTime,
      expiresAt:         s.expiresAt,
      coordinates:       s.location?.coordinates,
      createdAt:         s.createdAt,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getMySessions
//
// Returns all sessions where the user is a participant (created or joined).
// Used by the MessageActivity Sessions tab.
//
// Chat visibility rule (per spec):
//  • chat is accessible while status = 'active'  (showTime + 3 hrs)
//  • after 3 hrs: chat document still exists, status becomes 'expired'
//    → returned but flagged chatReadOnly = true so UI disables input
//
// IMPORTANT: we do NOT filter by session status — even expired-card sessions
// are returned as long as the chat window is still open.
// ─────────────────────────────────────────────────────────────────────────────
async function getMySessions(userId) {
  const sessions = await MovieSession.find({
    participants: userId,
  })
    .populate('participants', 'firstName lastName profilePhoto')
    .sort({ showTime: -1 })
    .limit(50)
    .lean();

  // Attach chat status for each session
  const chatIds = sessions
    .map(s => s.chatId)
    .filter(Boolean);

  const chats = await MovieChat.find({ _id: { $in: chatIds } })
    .select('_id status expiresAt')
    .lean();

  const chatMap = {};
  chats.forEach(c => { chatMap[c._id.toString()] = c; });

  const now = new Date();

  return {
    success: true,
    sessions: sessions.map(s => {
      const chat     = s.chatId ? chatMap[s.chatId.toString()] : null;
      const chatOpen = chat && chat.status === 'active' && new Date(chat.expiresAt) > now;

      return {
        id:                 s._id.toString(),
        movieId:            s.movieId,
        title:              s.movieTitle,
        posterPath:         s.poster || null,
        theatreName:        s.theatreName,
        theatreAddress:     s.theatreAddress,
        showTime:           s.showTime?.toISOString()     || null,
        expiresAt:          s.expiresAt?.toISOString()    || null,
        chatExpiresAt:      s.chatExpiresAt?.toISOString() || null,
        date:               s.date || '',
        time:               s.time || '',
        participants:       (s.participants || []).map(p => ({
          id:           p._id.toString(),
          firstName:    p.firstName || '',
          profilePhoto: p.profilePhoto || null,
        })),
        participantsCount:  s.participants?.length || 0,
        maxParticipants:    s.maxParticipants,
        isSystemGenerated:  s.isSystemGenerated,
        sessionStatus:      s.status,             // 'active' | 'expired'  (card)
        chatId:             s.chatId?.toString() || null,
        chatStatus:         chat?.status || 'expired',
        chatOpen,           // true = user can type; false = read-only
        isCreator:          s.createdBy?.toString?.() === userId.toString(),
        timeLabel:          getTimeLabel(s.showTime),
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getSuggestionForMovie(userId, movieId, movieTitle)
//
// Called when a user selects a movie in the create flow.
// Checks if an active session exists for the same movie in the same city
// within 10-15 km AND within the next 2 hours.
//
// Returns ONE suggestion at most (spec: "show ONLY ONE suggestion").
//
// If found → client shows the join-or-skip dialog:
//   "A hangout for {movie} is happening nearby"
//   📍 Meetup near {theatre}
//   🕒 {time}
//   👥 {participants}
//   🎟️ Tickets not included. Please book separately.
//   [Join ❤️]  [Skip]
//
// If not found → { suggestion: null } → client continues to create flow
// ─────────────────────────────────────────────────────────────────────────────
async function getSuggestionForMovie(userId, movieId, queryLat, queryLng) {
  if (!movieId) return { success: false, message: 'movieId required' };

  const [loc, userCtx] = await Promise.all([
    _resolveLocation(queryLat, queryLng, userId),
    _fetchUserContext(userId),
  ]);

  const city = (userCtx?.city || '').trim().toLowerCase();
  const now  = new Date();
  const in2h = new Date(now.getTime() + 2 * 3_600_000);

  // Base filter: same movie, same city, active, starts within next 2 hours
  const query = {
    movieId:   movieId.toString(),
    status:    'active',
    expiresAt: { $gt: now },
    showTime:  { $lte: in2h, $gt: now },
    ...(city ? { city } : {}),
  };

  // Geo filter: within 15 km if we have coordinates
  let sessions = [];
  if (loc.lat !== null && loc.lng !== null) {
    try {
      sessions = await MovieSession.find({
        ...query,
        location: {
          $nearSphere: {
            $geometry:    { type: 'Point', coordinates: [loc.lng, loc.lat] },
            $maxDistance: 15_000,  // 15 km
          },
        },
      })
        .populate('participants', 'firstName lastName profilePhoto')
        .limit(5)
        .lean();
    } catch (_) {
      // geo query failed — fall back to city-only
    }
  }

  // Fallback: city-only if no geo or no geo results
  if (!sessions.length) {
    sessions = await MovieSession.find(query)
      .populate('participants', 'firstName lastName profilePhoto')
      .sort({ participants: -1, showTime: 1 })
      .limit(5)
      .lean();
  }

  if (!sessions.length) {
    return { success: true, suggestion: null };
  }

  // Pick the best one: most participants, then earliest time
  const best = sessions
    .filter(s => s.participants.length < s.maxParticipants) // not full
    .sort((a, b) => {
      if (b.participants.length !== a.participants.length)
        return b.participants.length - a.participants.length;
      return new Date(a.showTime) - new Date(b.showTime);
    })[0];

  if (!best) return { success: true, suggestion: null };

  const distM = (loc.lat !== null && best.location?.coordinates)
    ? _haversine(loc.lat, loc.lng, best.location.coordinates[1], best.location.coordinates[0])
    : null;

  const participantCount = best.participants.length;
  const participantText  = participantCount === 0
    ? '👥 Be among the first to join'
    : `👥 ${participantCount}/${best.maxParticipants} going`;

  return {
    success: true,
    suggestion: {
      sessionId:        best._id.toString(),
      movieTitle:       best.movieTitle,
      theatreName:      best.theatreName,
      theatreAddress:   best.theatreAddress,
      showTime:         best.showTime?.toISOString() || null,
      date:             best.date,
      time:             best.time,
      timeLabel:        getTimeLabel(best.showTime),
      participantText,
      participantsCount: participantCount,
      maxParticipants:  best.maxParticipants,
      chatId:           best.chatId?.toString() || null,
      distance:         distM !== null ? Math.round(distM) : null,
      // UI copy — exactly per spec
      headline:         `A hangout for ${best.movieTitle} is happening nearby`,
      locationLine:     `📍 Meetup near ${best.theatreName}`,
      timeLine:         `🕒 ${best.date}  ${best.time}`,
      participantLine:  participantText,
      ticketNote:       '🎟️ Tickets are not included. Please book separately.',
    },
  };
}

module.exports = {
  getMovies,
  getNearbyTheatres,
  searchTheatres,
  getNearbySessions,
  createSession,
  joinSession,
  getSessionChat,
  sendMessage,
  sendPostSessionNotifications,
  debugSessions,
  getMySessions,
  getSuggestionForMovie,
  // Exported for use by expiry job
  fetchTrendingMovies,
  generateSystemSessions,
  countNearbyRealUserSessions,
  getSessionSummary,
};
