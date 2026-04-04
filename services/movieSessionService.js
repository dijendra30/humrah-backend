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
const { getTimeLabel, getParticipantDisplay, getPostSessionMessage,
        getNextShowTime, isCreationAllowed, validateShowTime, isAfterEndHour } = require('../utils/timeLabel');

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_LANGUAGE  = 'Hindi';
const MAX_RADIUS_M      = 20_000;   // 20 km initial fetch
const WIDE_RADIUS_M     = 50_000;   // 50 km fallback

// ─── Fallback movies (used when TMDB key missing / request fails) ─────────────
const FALLBACK_MOVIES = [
  { id: '1136406', title: 'Leo',              posterPath: null },
  { id: '1212458', title: 'Animal',           posterPath: null },
  { id: '976573',  title: 'Jawan',            posterPath: null },
  { id: '1126166', title: 'Salaar',           posterPath: null },
  { id: '1010591', title: 'Rocky Aur Rani',   posterPath: null },
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
      .select('questionnaire last_known_lat last_known_lng firstName lastName profilePhoto')
      .lean();
    if (!user) return null;
    return {
      languagePreference: user.questionnaire?.languagePreference
                       || user.questionnaire?.language
                       || DEFAULT_LANGUAGE,
      lat:       user.last_known_lat || null,
      lng:       user.last_known_lng || null,
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

  // Tier 4 — nuclear: no filters at all
  try {
    const rows = await MovieSession.find({}).populate(populateOpts).sort({ createdAt: -1 }).limit(10);
    console.log(`  [fetch] nuclear → ${rows.length} row(s)`);
    return rows;
  } catch (err) {
    console.error(`  [fetch] nuclear error: ${err.message}`);
    return [];
  }
}

// ─── Scoring for sort ─────────────────────────────────────────────────────────
// Priority (per spec): language → boosted → distance → time → participants
function _scoreSession(session, now, userLang, userLat, userLng) {
  let score = 0;

  // 1. Language match — 'Both' is wildcard
  const langMatch = userLang === 'Both'
    || session.language === 'Both'
    || session.language === userLang;
  if (langMatch) score += 100;

  // 2. Boosted
  if (session.isBoosted) score += 40;

  // 3. Distance (closer = more points, max 30)
  if (userLat !== null && userLng !== null && session.location?.coordinates) {
    const distM = _haversine(
      userLat, userLng,
      session.location.coordinates[1], session.location.coordinates[0]
    );
    score += Math.max(0, 30 - distM / 1000);
  }

  // 4. Time proximity — soonest shows first
  const hrs = (new Date(session.showTime) - now) / 3_600_000;
  if (hrs > 0 && hrs < 2)       score += 20;
  else if (hrs >= 2 && hrs < 6)  score += 12;
  else if (hrs >= 6 && hrs < 12) score += 5;

  // 5. Participants count descending (social proof)
  score += Math.min(session.participants.length * 3, 12);

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
// fetchTrendingMovies — TMDB with 15-min cache + FALLBACK_MOVIES
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
    const params = new URLSearchParams({
      api_key:            KEY,
      region:             'IN',
      sort_by:            'popularity.desc',
      with_release_type:  '2|3',
      'release_date.gte': '2024-01-01',
      'vote_count.gte':   '100',
      language:           'en-IN',
      page:               '1',
    });
    const res = await fetch(`https://api.themoviedb.org/3/discover/movie?${params}`);
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
    const data = await res.json();
    const list = (data.results || []).slice(0, 20).map(m => ({
      id: m.id, title: m.title, posterPath: m.poster_path || null,
      rating: Math.round(m.vote_average * 10) / 10,
    }));
    if (!list.length) throw new Error('TMDB returned 0 results');
    _moviesCache = { data: list, ts: now };
    console.log(`[movies] TMDB: ${list.length} movie(s) cached`);
    return list;
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
// generateSystemSessions
//
// GUARANTEES:
//  • Always has movies   (TMDB → FALLBACK_MOVIES)
//  • Always has theatres (Places API v1 → fallback at user coords)
//  • participants = [] — NEVER fake user IDs
//  • adminId = null — first joiner gets assigned atomically
//  • At least session[0] matches user's language
// ─────────────────────────────────────────────────────────────────────────────
async function generateSystemSessions(userCtx, lat, lng) {
  console.log('\n🤖 generateSystemSessions START');
  console.log(`   lat=${lat}, lng=${lng}, lang=${userCtx?.languagePreference}`);

  const [movies, theatres] = await Promise.all([
    fetchTrendingMovies(),
    fetchNearbyTheatres(lat, lng),
  ]);

  console.log(`   movies=${movies.length}, theatres=${theatres.length}`);

  const now      = new Date();
  const userLang = userCtx?.languagePreference || DEFAULT_LANGUAGE;
  const langPool = [userLang, 'Hindi', 'English', 'Tamil']
    .filter((v, i, a) => a.indexOf(v) === i);
  let created    = 0;

  for (let i = 0; i < Math.min(3, movies.length); i++) {
    try {
      const movie   = movies[i];
      const theatre = theatres[i % theatres.length];

      // Session 0 always matches user language
      const lang    = i === 0 ? userLang : (langPool[i % langPool.length] || DEFAULT_LANGUAGE);

      // ── getNextShowTime() enforces 9 AM–8 PM window per spec ──────────────
      // Offsets: 20, 40, 60 min from now — each automatically snaps to
      // tomorrow 10 AM if the offset would push past 8 PM.
      const offsetMin = 20 + i * 20;
      const showTime  = getNextShowTime(offsetMin);
      const expiresAt = new Date(showTime.getTime() +  15 * 60_000);
      const chatExpAt = new Date(showTime.getTime() + 180 * 60_000);
      const dateStr   = showTime.toLocaleDateString('en-CA');      // YYYY-MM-DD in local tz
      const timeStr   = `${String(showTime.getHours()).padStart(2,'0')}:${String(showTime.getMinutes()).padStart(2,'0')}`;

      console.log(`   [${i}] "${movie.title}" @ "${theatre.name}" (${lang}, ${timeStr})`);

      // Duplicate guard
      const exists = await MovieSession.exists({
        movieId: movie.id.toString(), theatreName: theatre.name,
        date: dateStr, time: timeStr, status: 'active',
      });
      if (exists) { console.log(`   [${i}] skip — duplicate`); continue; }

      // Create session first — no circular reference
      const session = await MovieSession.create({
        movieId:           movie.id.toString(),
        movieTitle:        movie.title,
        poster:            movie.posterPath || null,
        language:          lang,
        theatreName:       theatre.name,
        theatreAddress:    theatre.address || 'Nearby Cinema',
        theatrePlaceId:    theatre.placeId || null,
        location: {
          type:        'Point',
          coordinates: [parseFloat(theatre.lng), parseFloat(theatre.lat)],
        },
        date:              dateStr,
        time:              timeStr,
        showTime,
        expiresAt,
        chatExpiresAt:     chatExpAt,
        createdBy:         'system',
        participants:      [],         // EMPTY — never fake users
        adminId:           null,       // assigned atomically on first join
        maxParticipants:   4,
        isBoosted:         false,
        isSystemGenerated: true,
        status:            'active',
        chatId:            null,
      });

      console.log(`   [${i}] ✅ session ${session._id}`);

      // Create chat (sessionId now available)
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
        console.log(`   [${i}] ✅ chat ${chat._id}`);
      } catch (chatErr) {
        console.warn(`   [${i}] ⚠️ chat failed: ${chatErr.message}`);
      }

      created++;
    } catch (err) {
      console.error(`   [${i}] ❌ failed: ${err.message}`);
      if (err.name === 'ValidationError') {
        console.error('   Validation:', JSON.stringify(err.errors, null, 2));
      }
    }
  }

  console.log(`🤖 generateSystemSessions END — ${created} created\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// getMovies — public API response
// ─────────────────────────────────────────────────────────────────────────────
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
  console.log(`\n📡 getNearbySessions — lang="${userLang}" loc=(${loc.lat},${loc.lng}) via ${loc.source}`);

  const baseQuery = { status: 'active', expiresAt: { $gt: now } };

  // STEP 1
  let sessions = await _fetchSessionsFromDB(loc, baseQuery);
  console.log(`STEP 1: ${sessions.length} session(s)`);

  // STEP 2
  if (sessions.length < 2) {
    console.log('STEP 2: feed sparse → generateSystemSessions()');
    const genLat = loc.lat ?? userCtx?.lat ?? null;
    const genLng = loc.lng ?? userCtx?.lng ?? null;

    if (genLat !== null && genLng !== null) {
      await generateSystemSessions(userCtx || { languagePreference: userLang }, genLat, genLng);
    } else {
      console.warn('STEP 2: no coordinates — cannot generate');
    }

    // STEP 3 — re-fetch
    sessions = await _fetchSessionsFromDB(loc, baseQuery);
    console.log(`STEP 3: ${sessions.length} session(s) after generation`);
  }

  // STEP 4 — score, sort, top 5
  const scored = sessions.map(s => {
    const distM = (loc.lat !== null && s.location?.coordinates)
      ? _haversine(loc.lat, loc.lng, s.location.coordinates[1], s.location.coordinates[0])
      : null;
    return {
      formatted: _formatSession(s, userId, distM),
      score:     _scoreSession(s, now, userLang, loc.lat, loc.lng),
    };
  });

  // Language-match bucket first, then others — both sorted by score
  const isMatch = (x) => {
    const lang = x.formatted.language;
    return userLang === 'Both' || lang === 'Both' || lang === userLang;
  };
  const langMatch = scored.filter(isMatch).sort((a, b) => b.score - a.score);
  const others    = scored.filter(x => !isMatch(x)).sort((a, b) => b.score - a.score);

  const top5 = [...langMatch, ...others]
    .slice(0, 5)
    .map(x => x.formatted);

  console.log(`STEP 4: returning ${top5.length} session(s)\n`);

  return { success: true, userLanguage: userLang, sessions: top5 };
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

  // Language from profile — never from client
  const userCtx  = await _fetchUserContext(userId);
  const language = userCtx?.languagePreference || DEFAULT_LANGUAGE;
  console.log(`[create] lang from profile: "${language}"`);

  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi]    = time.split(':').map(Number);
  const showTime   = new Date(y, mo - 1, d, h, mi, 0);

  // ── Time rules: 9 AM–8 PM window + 7:30 PM creation cutoff ─────────────
  // validateShowTime() checks future + 9 AM–8 PM bounds
  const timeCheck = validateShowTime(showTime);
  if (!timeCheck.valid) {
    return { success: false, status: 400, message: timeCheck.reason };
  }

  // Creation cutoff: reject today-sessions after 7:30 PM
  if (!isCreationAllowed()) {
    // Check if the requested showTime is today
    const isToday = showTime.toDateString() === new Date().toDateString();
    if (isToday) {
      return {
        success: false,
        status:  400,
        message: "It's past 7:30 PM — you can only create sessions for tomorrow now.",
      };
    }
  }

  const expiresAt = new Date(showTime.getTime() +  15 * 60_000);
  const chatExpAt = new Date(showTime.getTime() + 180 * 60_000);

  // Duplicate guard
  const dup = await MovieSession.findOne({
    createdBy: userId, movieId: movieId.toString(), date, time, status: 'active',
  });
  if (dup) return { success: false, status: 409, message: 'You already have an active session for this movie at the same time' };

  // Create session — creator is first (and only initial) participant
  const session = await MovieSession.create({
    movieId:           movieId.toString(),
    movieTitle:        title,
    poster:            posterPath || null,
    language,
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
// getSessionChat — member-only access
// ─────────────────────────────────────────────────────────────────────────────
async function getSessionChat(userId, sessionId) {
  const session = await MovieSession.findById(sessionId);
  if (!session) return { success: false, status: 404, message: 'Session not found' };

  const isMember = session.participants.some(p => p.toString() === userId.toString());
  if (!isMember) return { success: false, status: 403, message: 'You are not a member of this session' };

  const chat = await MovieChat.findById(session.chatId);
  if (!chat) return { success: false, status: 404, message: 'Chat not found' };

  return {
    success: true,
    chat: {
      id:           chat._id.toString(),
      sessionId:    chat.sessionId?.toString() || null,
      participants: chat.participants.map(p => p.toString()),
      messages:     chat.messages.map(m => ({
        senderId:    m.senderId?.toString() || null,
        senderName:  m.senderName,
        senderPhoto: m.senderPhoto || null,
        text:        m.text,
        isSystem:    m.isSystem || false,
        timestamp:   m.timestamp.toISOString(),
      })),
      expiresAt: chat.expiresAt.toISOString(),
      status:    chat.status,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sendMessage
// ─────────────────────────────────────────────────────────────────────────────
async function sendMessage(userId, sessionId, text, io) {
  if (!text?.trim()) return { success: false, status: 400, message: 'Message text required' };

  const session = await MovieSession.findById(sessionId);
  if (!session) return { success: false, status: 404, message: 'Session not found' };

  const isMember = session.participants.some(p => p.toString() === userId.toString());
  if (!isMember) return { success: false, status: 403, message: 'Not a member' };

  const chat = await MovieChat.findById(session.chatId);
  if (!chat || chat.status === 'expired') {
    return { success: false, status: 400, message: 'Chat no longer available' };
  }

  const User   = mongoose.model('User');
  const sender = await User.findById(userId).select('firstName lastName profilePhoto').lean();
  const msg    = {
    senderId:    userId,
    senderName:  sender ? `${sender.firstName} ${sender.lastName || ''}`.trim() : 'User',
    senderPhoto: sender?.profilePhoto || null,
    text:        text.trim(),
    isSystem:    false,
    timestamp:   new Date(),
  };

  chat.messages.push(msg);
  await chat.save();

  // Socket broadcast
  try {
    if (io) {
      io.to(`movie-chat-${chat._id}`).emit('movie-new-message', {
        senderId:    userId.toString(),
        senderName:  msg.senderName,
        senderPhoto: msg.senderPhoto,
        text:        msg.text,
        isSystem:    false,
        timestamp:   msg.timestamp.toISOString(),
      });
    }
  } catch (_) { /* non-critical */ }

  return { success: true, message: 'Sent' };
}

// ─────────────────────────────────────────────────────────────────────────────
// sendPostSessionNotifications
// Called by expiry job when showTime + 15 min passes.
//
// Sends FCM push + (optionally) activity feed entry.
// Messages per spec:
//  1  participant  → "Your hangout didn't get any joins this time. Try again later."
//  ≤2 participants → "Only a few people joined this time. Try again with a different time."
//  ≥3 participants → "Your hangout was active 🎉 Hope you had a great time!"
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
  // Exported for use by expiry job
  fetchTrendingMovies,
  generateSystemSessions,
};
