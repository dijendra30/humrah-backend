// controllers/movieSessionController.js
// ─────────────────────────────────────────────────────────────────────────────
// BUGS FIXED IN THIS VERSION:
//
// BUG 1: MovieChat.create({ sessionId: null }) threw ValidationError because
//         schema had required:true — fixed in MovieChat.js (required removed).
//         Also fixed create order: session first, chat second (sessionId available).
//
// BUG 2: generateSystemSessions() silently returned when TMDB or Google Places
//         returned [] — fixed with hardcoded FALLBACK_MOVIES + buildFallbackTheatres().
//
// BUG 3: Re-fetch after generation used same strict $nearSphere — fixed with
//         tiered fetchSessionsFromDB(): 20 km → 50 km → no-geo plain find.
//
// BUG 4: generateSystemSessions() had no per-session try/catch — one save failure
//         crashed the whole loop silently. Fixed with individual try/catch + logs.
//
// BUG 5: No logging inside generation — impossible to know what was failing.
//         Fixed with step-by-step console.log throughout the entire flow.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose     = require('mongoose');
const MovieSession = require('../models/MovieSession');
const MovieChat    = require('../models/MovieChat');

const DEFAULT_LANGUAGE = 'Hindi';

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK MOVIES  (used when TMDB API key is missing or request fails)
// ─────────────────────────────────────────────────────────────────────────────
const FALLBACK_MOVIES = [
  { id: '1136406', title: 'Leo',              posterPath: null, rating: 7.2 },
  { id: '1212458', title: 'Animal',           posterPath: null, rating: 7.8 },
  { id: '976573',  title: 'Jawan',            posterPath: null, rating: 7.5 },
  { id: '1126166', title: 'Salaar',           posterPath: null, rating: 7.0 },
  { id: '1010591', title: 'Rocky Aur Rani',   posterPath: null, rating: 7.1 },
];

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK THEATRE BUILDER  (used when Google Places key is missing or fails)
// Places fake theatres AT the user's coordinates so geo queries always find them.
// ─────────────────────────────────────────────────────────────────────────────
function buildFallbackTheatres(lat, lng) {
  return [
    { placeId: 'fb_1', name: 'City Multiplex', address: 'City Centre',   lat,             lng,             distance: 0    },
    { placeId: 'fb_2', name: 'PVR Cinemas',    address: 'Mall Road',     lat: lat + 0.005, lng: lng + 0.005, distance: 700  },
    { placeId: 'fb_3', name: 'INOX Megaplex',  address: 'High Street',   lat: lat + 0.009, lng: lng - 0.003, distance: 1100 },
  ];
}

// ─── In-memory TMDB cache (15 min) ───────────────────────────────────────────
let moviesCache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 15 * 60 * 1000;

// ─── Haversine distance (metres) ─────────────────────────────────────────────
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Fetch user context (language + DB location) ──────────────────────────────
async function fetchUserContext(userId) {
  try {
    const User = mongoose.model('User');
    const user = await User.findById(userId)
      .select('questionnaire last_known_lat last_known_lng')
      .lean();
    if (!user) return null;
    return {
      languagePreference: user.questionnaire?.languagePreference || user.questionnaire?.language || DEFAULT_LANGUAGE,
      lat: user.last_known_lat || null,
      lng: user.last_known_lng || null,
    };
  } catch (err) {
    console.error('fetchUserContext error:', err.message);
    return null;
  }
}

// ─── Resolve best lat/lng: query params first, then DB ───────────────────────
async function resolveLocation(queryLat, queryLng, userId) {
  const lat = parseFloat(queryLat);
  const lng = parseFloat(queryLng);
  if (!isNaN(lat) && !isNaN(lng)) return { lat, lng, source: 'query' };
  const ctx = await fetchUserContext(userId);
  if (ctx?.lat !== null && ctx?.lng !== null) return { lat: ctx.lat, lng: ctx.lng, source: 'db' };
  return { lat: null, lng: null, source: 'none' };
}

// ─── Tiered session fetch: 20 km → 50 km → no-geo fallback ──────────────────
// This ensures re-fetch after generation always returns data even if the
// 2dsphere index isn't warmed up yet or the theatre is slightly outside radius.
async function fetchSessionsFromDB(loc, baseQuery) {
  // ✅ FIX 1: Do NOT populate 'createdBy' here.
  // When createdBy = 'system' (a plain string), Mongoose tries to cast it to
  // ObjectId for the User model → CastError crashes the entire re-fetch.
  // formatSession() already handles createdBy=system via isSystemGenerated flag.
  const populate = [
    { path: 'participants', select: 'firstName lastName profilePhoto' },
  ];

  if (loc.lat !== null && loc.lng !== null) {
    for (const radiusM of [20000, 50000]) {
      try {
        const rows = await MovieSession.find({
          ...baseQuery,
          theatreLocation: {
            $nearSphere: {
              $geometry:    { type: 'Point', coordinates: [loc.lng, loc.lat] },
              $maxDistance: radiusM,
            },
          },
        }).populate(populate).limit(30);

        console.log(`  fetchSessionsFromDB [${radiusM / 1000} km]: ${rows.length} row(s)`);
        if (rows.length > 0) return rows;
      } catch (geoErr) {
        console.warn(`  fetchSessionsFromDB geo ${radiusM}m failed: ${geoErr.message}`);
      }
    }
  }

  // No-geo fallback: return any active sessions
  const rows = await MovieSession.find(baseQuery)
    .populate(populate)
    .sort({ createdAt: -1 })
    .limit(20);
  console.log(`  fetchSessionsFromDB [no-geo]: ${rows.length} row(s)`);
  return rows;
}

// ─── Fetch trending movies (TMDB → hardcoded fallback) ───────────────────────
async function fetchTrendingMovies() {
  const now = Date.now();
  if (moviesCache.data?.length && now - moviesCache.timestamp < CACHE_TTL_MS) {
    return moviesCache.data;
  }

  const TMDB_KEY = process.env.TMDB_API_KEY;
  if (!TMDB_KEY) {
    console.warn('TMDB_API_KEY not set — using fallback movies');
    return FALLBACK_MOVIES;
  }

  try {
    const params = new URLSearchParams({
      api_key:            TMDB_KEY,
      region:             'IN',
      sort_by:            'popularity.desc',
      with_release_type:  '2|3',
      'release_date.gte': '2024-01-01',
      'vote_count.gte':   '100',
      language:           'en-IN',
      page:               '1',
    });
    const res  = await fetch(`https://api.themoviedb.org/3/discover/movie?${params}`);
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
    const data = await res.json();
    const list = (data.results || []).slice(0, 20).map(m => ({
      id: m.id, title: m.title, posterPath: m.poster_path || null,
      rating: Math.round(m.vote_average * 10) / 10,
    }));
    if (!list.length) throw new Error('TMDB returned 0 results');
    moviesCache = { data: list, timestamp: now };
    return list;
  } catch (err) {
    console.warn(`TMDB failed (${err.message}) — using fallback movies`);
    return moviesCache.data?.length ? moviesCache.data : FALLBACK_MOVIES;
  }
}

// ─── Fetch nearby theatres (Google Places → fallback at user coords) ──────────
// ✅ FIX 3: New Google Places API v1 (POST, not GET)
// Old nearbysearch endpoint returns REQUEST_DENIED with new API keys.
// New endpoint: POST https://places.googleapis.com/v1/places:searchNearby
async function fetchNearbyTheatres(lat, lng, radius = 8000) {
  if (lat === null || lng === null) return buildFallbackTheatres(0, 0);

  const KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!KEY) {
    console.warn('GOOGLE_PLACES_API_KEY not set — using fallback theatres');
    return buildFallbackTheatres(lat, lng);
  }

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Goog-Api-Key':  KEY,
        // Only request the fields we actually use (billed per field)
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.location',
      },
      body: JSON.stringify({
        includedTypes:    ['movie_theater'],
        maxResultCount:   20,
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: parseFloat(radius),
          },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Places API HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();

    // New API returns { places: [...] }, NOT { results: [...] }
    const results = data.places || [];

    if (!results.length) {
      console.warn('Google Places v1 returned 0 theatres — using fallback');
      return buildFallbackTheatres(lat, lng);
    }

    const list = results.map(p => {
      const pLat = p.location?.latitude  || 0;
      const pLng = p.location?.longitude || 0;
      return {
        placeId:  p.id                     || '',
        name:     p.displayName?.text      || 'Cinema',
        address:  p.formattedAddress       || '',
        rating:   p.rating                 || null,
        distance: Math.round(haversineDistance(lat, lng, pLat, pLng)),
        lat:      pLat,
        lng:      pLng,
      };
    }).sort((a, b) => a.distance - b.distance);

    console.log(`📍 Google Places v1: ${list.length} theatre(s) found`);
    return list;

  } catch (err) {
    console.warn(`Google Places v1 failed (${err.message}) — using fallback theatres`);
    return buildFallbackTheatres(lat, lng);
  }
}

// ─── Score a session for feed ranking ────────────────────────────────────────
function scoreSession(session, now, userLang, userLat, userLng) {
  let score = 0;
  // ✅ FIX 2: "Both" means the user accepts any language → always match
  const langMatches = userLang === 'Both'
    || session.language === 'Both'
    || session.language === userLang;
  if (langMatches) score += 100;
  if (session.isBoosted) score += 40;

  if (userLat !== null && userLng !== null && session.theatreLocation?.coordinates) {
    const d = haversineDistance(
      userLat, userLng,
      session.theatreLocation.coordinates[1],
      session.theatreLocation.coordinates[0]
    );
    score += Math.max(0, 30 - d / 1000);
  }

  const hrs = (new Date(session.showTime) - now) / 3_600_000;
  if (hrs > 0 && hrs < 2)       score += 20;
  else if (hrs >= 2 && hrs < 6)  score += 12;
  else if (hrs >= 6 && hrs < 12) score += 5;

  const fill  = (session.participants?.length || 0) + (session.simulatedParticipants || 0);
  const ratio = fill / (session.maxParticipants || 4);
  if (ratio >= 0.5 && ratio < 1) score += 10;
  else if (ratio > 0)             score += 5;

  return score;
}

// ─── Format session for API response ─────────────────────────────────────────
function formatSession(s, currentUserId, distM = null) {
  const toP = (p) => {
    if (p && typeof p === 'object' && p._id)
      return { id: p._id.toString(), firstName: p.firstName || '', profilePhoto: p.profilePhoto || null };
    if (p) return { id: p.toString(), firstName: '', profilePhoto: null };
    return null;
  };

  const realP     = (s.participants || []).map(toP).filter(Boolean);
  const simCount  = s.simulatedParticipants || 0;
  const dispCount = realP.length + simCount;
  const creatorStr = s.createdBy?.toString?.() || 'system';
  const isSystem   = s.isSystemGenerated || creatorStr === 'system';

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
    createdBy:          isSystem ? null : toP(s.createdBy),
    participants:       realP,
    participantsCount:  dispCount,
    maxParticipants:    s.maxParticipants,
    spotsLeft:          s.maxParticipants - dispCount,
    isUrgent:           s.isBoosted || false,
    isBoosted:          s.isBoosted || false,
    isSystemGenerated:  isSystem,
    status:             s.status,
    chatId:             s.chatId?.toString() || null,
    distance:           distM !== null ? Math.round(distM) : null,
    isCreator:          currentUserId ? creatorStr === currentUserId.toString() : false,
    hasJoined:          currentUserId ? realP.some(p => p?.id === currentUserId.toString()) : false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// generateSystemSessions
//
// GUARANTEES:
//  • Never crashes the caller — all errors are caught + logged individually
//  • Always has movies   (TMDB → hardcoded FALLBACK_MOVIES)
//  • Always has theatres (Google Places → buildFallbackTheatres at user coords)
//  • Session created FIRST, then chat — no circular null reference issue
// ─────────────────────────────────────────────────────────────────────────────
async function generateSystemSessions(userCtx, lat, lng) {
  console.log('\n🤖 generateSystemSessions() START');
  console.log(`   lat=${lat}, lng=${lng}, lang=${userCtx?.languagePreference}`);

  const [movies, theatres] = await Promise.all([
    fetchTrendingMovies(),
    fetchNearbyTheatres(lat, lng),
  ]);

  console.log(`   movies=${movies.length}, theatres=${theatres.length}`);

  if (!movies.length || !theatres.length) {
    // Should never happen since both functions have hardcoded fallbacks, but guard anyway
    console.error('❌ generateSystemSessions: no movies or theatres even after fallbacks');
    return;
  }

  const now      = new Date();
  const userLang = userCtx?.languagePreference || DEFAULT_LANGUAGE;
  const langPool = [userLang, 'Hindi', 'English', 'Tamil'].filter((v, i, a) => a.indexOf(v) === i);
  let   created  = 0;

  for (let i = 0; i < Math.min(3, movies.length); i++) {
    try {
      const movie   = movies[i];
      const theatre = theatres[i % theatres.length];
      const lang    = i === 0 ? userLang : (langPool[i % langPool.length] || DEFAULT_LANGUAGE);

      const offsetMin = 30 + i * 20;     // 30, 50, 70 min from now
      const showTime  = new Date(now.getTime() + offsetMin * 60_000);
      const expiresAt = new Date(showTime.getTime() +  15 * 60_000);
      const chatExpAt = new Date(showTime.getTime() + 180 * 60_000);
      const dateStr   = showTime.toISOString().slice(0, 10);
      const timeStr   = showTime.toTimeString().slice(0, 5);

      console.log(`   [${i}] movie="${movie.title}" theatre="${theatre.name}" lang="${lang}" time="${timeStr}"`);

      // Duplicate guard
      const exists = await MovieSession.exists({
        movieId: movie.id.toString(), theatreName: theatre.name,
        date: dateStr, time: timeStr, status: 'active',
      });
      if (exists) { console.log(`   [${i}] skipped — duplicate`); continue; }

      // ── CREATE SESSION FIRST ──────────────────────────────────────────────
      const session = await MovieSession.create({
        movieId:           movie.id.toString(),
        movieTitle:        movie.title,
        poster:            movie.posterPath || null,
        language:          lang,
        theatreName:       theatre.name,
        theatreAddress:    theatre.address || 'Nearby Cinema',
        theatrePlaceId:    theatre.placeId || null,
        theatreLocation: {
          type:        'Point',
          coordinates: [parseFloat(theatre.lng), parseFloat(theatre.lat)],
        },
        date:              dateStr,
        time:              timeStr,
        showTime,
        expiresAt,
        chatExpiresAt:     chatExpAt,
        createdBy:         'system',
        participants:      [],
        simulatedParticipants: i === 0 ? 2 : 1,
        maxParticipants:   4,
        isBoosted:         false,
        isSystemGenerated: true,
        status:            'active',
        chatId:            null,
      });
      console.log(`   [${i}] ✅ session saved ${session._id}`);

      // ── CREATE CHAT SECOND (sessionId now available) ──────────────────────
      try {
        const chat = await MovieChat.create({
          sessionId:    session._id,   // ✅ valid ObjectId
          participants: [],
          messages:     [],
          expiresAt:    chatExpAt,
          status:       'active',
        });
        session.chatId = chat._id;
        await session.save();
        console.log(`   [${i}] ✅ chat saved ${chat._id}`);
      } catch (chatErr) {
        console.warn(`   [${i}] ⚠️ chat failed (non-fatal): ${chatErr.message}`);
      }

      created++;

    } catch (err) {
      console.error(`   [${i}] ❌ session failed: ${err.message}`);
      if (err.name === 'ValidationError') {
        console.error('   Validation errors:', JSON.stringify(err.errors, null, 2));
      }
    }
  }

  console.log(`🤖 generateSystemSessions() END — created ${created}\n`);
}

// =============================================================================
// GET /api/movies
// =============================================================================
exports.getMovies = async (req, res) => {
  try {
    const movies = await fetchTrendingMovies();
    return res.json({ success: true, movies });
  } catch (err) {
    console.error('getMovies error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/theatres?lat=&lng=&radius=
// =============================================================================
exports.getNearbyTheatres = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.userId;
    const { radius = 8000 } = req.query;

    const loc = await resolveLocation(req.query.lat, req.query.lng, userId);
    if (loc.lat === null || loc.lng === null) {
      return res.status(400).json({ success: false, message: 'Location unavailable. Enable location permission.' });
    }

    console.log(`📍 Theatre search via ${loc.source}: (${loc.lat}, ${loc.lng})`);
    const theatres = await fetchNearbyTheatres(loc.lat, loc.lng, parseInt(radius));
    return res.json({ success: true, locationSource: loc.source, theatres });

  } catch (err) {
    console.error('getNearbyTheatres error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// POST /api/movie-session/create
// =============================================================================
exports.createSession = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.userId;
    const { movieId, title, posterPath, theatreName, theatreAddress,
            theatrePlaceId, theatreLat, theatreLng,
            date, time, maxParticipants, isUrgent } = req.body;

    if (!movieId || !title || !theatreName || !theatreAddress || !date || !time) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    if (!theatreLat || !theatreLng) {
      return res.status(400).json({ success: false, message: 'Theatre location required' });
    }

    const userCtx  = await fetchUserContext(userId);
    const language = userCtx?.languagePreference || DEFAULT_LANGUAGE;
    console.log(`🌐 Session language from profile: "${language}"`);

    const [year, month, day] = date.split('-').map(Number);
    const [hours, minutes]   = time.split(':').map(Number);
    const showTime = new Date(year, month - 1, day, hours, minutes, 0);

    if (isNaN(showTime.getTime()) || showTime <= new Date()) {
      return res.status(400).json({ success: false, message: 'Show time must be in the future' });
    }

    const expiresAt = new Date(showTime.getTime() +  15 * 60_000);
    const chatExpAt = new Date(showTime.getTime() + 180 * 60_000);

    const dup = await MovieSession.findOne({ createdBy: userId, movieId: movieId.toString(), date, time, status: 'active' });
    if (dup) return res.status(409).json({ success: false, message: 'Duplicate session' });

    // Session first, chat second (consistent with generateSystemSessions)
    const session = await MovieSession.create({
      movieId: movieId.toString(), movieTitle: title, poster: posterPath || null,
      language, theatreName, theatreAddress, theatrePlaceId: theatrePlaceId || null,
      theatreLocation: { type: 'Point', coordinates: [parseFloat(theatreLng), parseFloat(theatreLat)] },
      date, time, showTime, expiresAt, chatExpiresAt: chatExpAt,
      createdBy: userId, participants: [userId],
      maxParticipants: parseInt(maxParticipants) || 5,
      isBoosted: Boolean(isUrgent), isSystemGenerated: false, status: 'active', chatId: null,
    });

    const chat = await MovieChat.create({
      sessionId: session._id, participants: [userId], messages: [], expiresAt: chatExpAt, status: 'active',
    });
    session.chatId = chat._id;
    await session.save();

    const populated = await MovieSession.findById(session._id)
      .populate('createdBy', 'firstName lastName profilePhoto')
      .populate('participants', 'firstName lastName profilePhoto');

    return res.status(201).json({ success: true, session: formatSession(populated, userId) });

  } catch (err) {
    console.error('createSession error:', err);
    if (err.name === 'ValidationError') console.error('Validation:', JSON.stringify(err.errors));
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/movie-session/nearby
//
// STRICT FLOW:
//  STEP 1 — fetch from DB (tiered geo query)
//  STEP 2 — if < 2 sessions → generate
//  STEP 3 — re-fetch from DB (same tiered query)
//  STEP 4 — sort + return
// =============================================================================
exports.getNearbySessions = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.userId;
    const now    = new Date();

    const [loc, userCtx] = await Promise.all([
      resolveLocation(req.query.lat, req.query.lng, userId),
      fetchUserContext(userId),
    ]);

    const userLang = userCtx?.languagePreference || DEFAULT_LANGUAGE;
    console.log(`\n📡 getNearbySessions — lang="${userLang}" loc=(${loc.lat},${loc.lng}) via ${loc.source}`);

    const baseQuery = { status: 'active', expiresAt: { $gt: now } };

    // STEP 1
    let sessions = await fetchSessionsFromDB(loc, baseQuery);
    console.log(`STEP 1: ${sessions.length} session(s)`);

    // STEP 2
    if (sessions.length < 2) {
      console.log('STEP 2: generating system sessions...');
      const genLat = loc.lat ?? userCtx?.lat ?? null;
      const genLng = loc.lng ?? userCtx?.lng ?? null;

      if (genLat !== null && genLng !== null) {
        await generateSystemSessions(userCtx || { languagePreference: userLang }, genLat, genLng);
      } else {
        console.warn('STEP 2: no coordinates — cannot generate');
      }

      // STEP 3
      sessions = await fetchSessionsFromDB(loc, baseQuery);
      console.log(`STEP 3: ${sessions.length} session(s) after generation`);
    }

    // STEP 4
    const formatted = sessions.map(s => {
      const d = (loc.lat !== null && s.theatreLocation?.coordinates)
        ? haversineDistance(loc.lat, loc.lng, s.theatreLocation.coordinates[1], s.theatreLocation.coordinates[0])
        : null;
      const score = scoreSession(s, now, userLang, loc.lat, loc.lng);
      return { ...formatSession(s.toObject ? s.toObject() : s, userId, d), _score: score };
    });

    // ✅ FIX 2b: treat "Both" as wildcard in bucket sort too
    const isLangMatch = (s) => userLang === 'Both' || s.language === 'Both' || s.language === userLang;
    const langMatch = formatted.filter(isLangMatch).sort((a, b) => b._score - a._score);
    const otherLang = formatted.filter(s => !isLangMatch(s)).sort((a, b) => b._score - a._score);
    const sorted    = [...langMatch, ...otherLang].slice(0, 10);
    sorted.forEach(s => delete s._score);

    console.log(`STEP 4: returning ${sorted.length} session(s)\n`);

    return res.json({ success: true, userLanguage: userLang, sessions: sorted });

  } catch (err) {
    console.error('❌ getNearbySessions error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// POST /api/movie-session/:id/join
// =============================================================================
exports.joinSession = async (req, res) => {
  try {
    const userId    = req.user?.id || req.user?._id || req.userId;
    const sessionId = req.params.id;

    const session = await MovieSession.findById(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    if (session.status === 'expired' || new Date() > session.expiresAt)
      return res.status(400).json({ success: false, message: 'Session expired' });

    const alreadyIn = session.participants.some(p => p.toString() === userId.toString());
    if (alreadyIn) return res.json({ success: true, message: 'Already a member', chatId: session.chatId?.toString() || null });
    if (session.participants.length >= session.maxParticipants)
      return res.status(400).json({ success: false, message: 'Session is full' });

    if (session.isSystemGenerated && session.participants.length === 0) {
      session.simulatedParticipants = 0;
    }

    session.participants.push(userId);
    await session.save();

    if (session.chatId) {
      const chat = await MovieChat.findById(session.chatId);
      if (chat && !chat.participants.some(p => p.toString() === userId.toString())) {
        chat.participants.push(userId);
        await chat.save();
      }
    }

    try {
      const io   = req.app.get('io');
      const User = mongoose.model('User');
      const j    = await User.findById(userId).select('firstName lastName');
      const cStr = session.createdBy?.toString?.() || 'system';
      if (cStr !== 'system') {
        io.to(`user-${cStr}`).emit('movie-session-joined', {
          sessionId: session._id.toString(),
          joinerName: j ? `${j.firstName} ${j.lastName || ''}`.trim() : 'Someone',
          movieTitle: session.movieTitle, participants: session.participants.length,
        });
      }
    } catch (_) { /* non-critical */ }

    return res.json({ success: true, message: 'Joined successfully', chatId: session.chatId?.toString() || null });

  } catch (err) {
    console.error('joinSession error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/movie-session/:id/chat
// =============================================================================
exports.getSessionChat = async (req, res) => {
  try {
    const userId    = req.user?.id || req.user?._id || req.userId;
    const session   = await MovieSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    if (!session.participants.some(p => p.toString() === userId.toString()))
      return res.status(403).json({ success: false, message: 'Not a member' });

    const chat = await MovieChat.findById(session.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

    return res.json({
      success: true,
      chat: {
        id: chat._id.toString(), sessionId: chat.sessionId?.toString() || null,
        participants: chat.participants.map(p => p.toString()),
        messages: chat.messages.map(m => ({
          senderId: m.senderId.toString(), senderName: m.senderName,
          senderPhoto: m.senderPhoto || null, text: m.text, timestamp: m.timestamp.toISOString(),
        })),
        expiresAt: chat.expiresAt.toISOString(), status: chat.status,
      },
    });
  } catch (err) {
    console.error('getSessionChat error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// POST /api/movie-session/:id/chat/message
// =============================================================================
exports.sendMessage = async (req, res) => {
  try {
    const userId  = req.user?.id || req.user?._id || req.userId;
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: 'Message required' });

    const session = await MovieSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    if (!session.participants.some(p => p.toString() === userId.toString()))
      return res.status(403).json({ success: false, message: 'Not a member' });

    const chat = await MovieChat.findById(session.chatId);
    if (!chat || chat.status === 'expired')
      return res.status(400).json({ success: false, message: 'Chat unavailable' });

    const User   = mongoose.model('User');
    const sender = await User.findById(userId).select('firstName lastName profilePhoto');
    const msg    = {
      senderId:    userId,
      senderName:  sender ? `${sender.firstName} ${sender.lastName || ''}`.trim() : 'User',
      senderPhoto: sender?.profilePhoto || null,
      text:        text.trim(),
      timestamp:   new Date(),
    };
    chat.messages.push(msg);
    await chat.save();

    try {
      req.app.get('io').to(`movie-chat-${chat._id}`).emit('movie-new-message', {
        senderId: userId.toString(), senderName: msg.senderName,
        senderPhoto: msg.senderPhoto, text: msg.text, timestamp: msg.timestamp.toISOString(),
      });
    } catch (_) { /* non-critical */ }

    return res.json({ success: true, message: 'Message sent' });

  } catch (err) {
    console.error('sendMessage error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/movie-session/debug   ← TEMPORARY — remove after confirming data flow
//
// Returns ALL sessions with NO filters so you can confirm data is being saved
// before suspecting query logic.
// =============================================================================
exports.debugSessions = async (req, res) => {
  try {
    const total  = await MovieSession.countDocuments({});
    const active = await MovieSession.countDocuments({ status: 'active' });
    const rows   = await MovieSession.find({}).sort({ createdAt: -1 }).limit(10).lean();

    return res.json({
      success: true,
      debug: true,
      totalCount:  total,
      activeCount: active,
      sessions: rows.map(s => ({
        id:                s._id,
        movieTitle:        s.movieTitle,
        theatreName:       s.theatreName,
        language:          s.language,
        status:            s.status,
        isSystemGenerated: s.isSystemGenerated,
        showTime:          s.showTime,
        expiresAt:         s.expiresAt,
        coordinates:       s.theatreLocation?.coordinates,
        createdAt:         s.createdAt,
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
