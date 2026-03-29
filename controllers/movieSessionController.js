// controllers/movieSessionController.js
// ─────────────────────────────────────────────────────────────────────────────
// Movie Hangout — complete controller
//
// KEY BEHAVIOURS:
//  • Language comes from user.questionnaire.languagePreference — NEVER from frontend
//  • Theatre search falls back to user's DB-stored coordinates when GPS not sent
//  • System-generated sessions auto-fill feed when < 2 real sessions exist
//  • Feed sorted: language match → boosted → distance → time proximity → fill %
// ─────────────────────────────────────────────────────────────────────────────
const mongoose    = require('mongoose');
const MovieSession = require('../models/MovieSession');
const MovieChat    = require('../models/MovieChat');

// ─── In-memory TMDB cache (15 min) ───────────────────────────────────────────
let moviesCache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 15 * 60 * 1000;

// Supported language values (match onboarding questionnaire)
const SUPPORTED_LANGUAGES = ['Hindi', 'English', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Marathi'];
const DEFAULT_LANGUAGE = 'Hindi';

// ─── Haversine distance (metres) ─────────────────────────────────────────────
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Fetch user from DB (attach language + location) ─────────────────────────
async function fetchUserContext(userId) {
  const User = mongoose.model('User');
  const user = await User.findById(userId)
    .select('questionnaire last_known_lat last_known_lng last_location_updated_at')
    .lean();
  if (!user) return null;

  const langPref = user.questionnaire?.languagePreference
    || user.questionnaire?.language
    || DEFAULT_LANGUAGE;

  return {
    languagePreference: langPref,
    lat: user.last_known_lat  || null,
    lng: user.last_known_lng  || null,
    locationUpdatedAt: user.last_location_updated_at || null
  };
}

// ─── Resolve best lat/lng: query params → DB → null ──────────────────────────
async function resolveLocation(queryLat, queryLng, userId) {
  const lat = parseFloat(queryLat);
  const lng = parseFloat(queryLng);

  if (!isNaN(lat) && !isNaN(lng)) return { lat, lng, source: 'query' };

  // Fall back to DB location
  const ctx = await fetchUserContext(userId);
  if (ctx && ctx.lat !== null && ctx.lng !== null) {
    return { lat: ctx.lat, lng: ctx.lng, source: 'db' };
  }
  return { lat: null, lng: null, source: 'none' };
}

// ─── Score a session for feed ranking ────────────────────────────────────────
// Priority: 1=language match, 2=boosted, 3=distance, 4=time proximity, 5=fill %
function scoreSession(session, now, userLang, userLat, userLng) {
  let score = 0;

  // 1. Language match (highest weight)
  if (session.language === userLang) score += 100;

  // 2. Boosted
  if (session.isBoosted) score += 40;

  // 3. Distance (closer = more points, max 30)
  if (userLat !== null && userLng !== null && session.theatreLocation?.coordinates) {
    const distM = haversineDistance(
      userLat, userLng,
      session.theatreLocation.coordinates[1],
      session.theatreLocation.coordinates[0]
    );
    score += Math.max(0, 30 - (distM / 1000));   // -1 per km, floor 0
  }

  // 4. Time proximity — soonest wins (max 20)
  const hoursUntilShow = (new Date(session.showTime) - now) / 3_600_000;
  if (hoursUntilShow > 0 && hoursUntilShow < 2)       score += 20;
  else if (hoursUntilShow >= 2 && hoursUntilShow < 6)  score += 12;
  else if (hoursUntilShow >= 6 && hoursUntilShow < 12) score += 5;

  // 5. Social proof: 2/4 or 3/4 filled (max 10)
  const fill = session.participants?.length || 0;
  const max  = session.maxParticipants || 4;
  const ratio = fill / max;
  if (ratio >= 0.5 && ratio < 1) score += 10;
  else if (ratio > 0)             score += 5;

  return score;
}

// ─── Shape session for API response ──────────────────────────────────────────
function formatSession(session, currentUserId, distanceMeters = null) {
  const toP = (p) => {
    if (typeof p === 'object' && p?._id) {
      return { id: p._id.toString(), firstName: p.firstName || '', profilePhoto: p.profilePhoto || null };
    }
    return { id: p.toString(), firstName: '', profilePhoto: null };
  };

  const participants = (session.participants || []).map(toP);
  const creatorId    = session.createdBy?._id?.toString() || session.createdBy?.toString() || 'system';
  const isSystem     = session.isSystemGenerated || creatorId === 'system';

  return {
    id:              session._id.toString(),
    movieId:         session.movieId,
    title:           session.movieTitle,
    posterPath:      session.poster         || null,
    language:        session.language       || DEFAULT_LANGUAGE,
    theatreName:     session.theatreName,
    theatreAddress:  session.theatreAddress,
    date:            session.date           || '',
    time:            session.time           || '',
    showTime:        session.showTime?.toISOString()    || null,
    expiresAt:       session.expiresAt?.toISOString()   || null,
    chatExpiresAt:   session.chatExpiresAt?.toISOString()|| null,
    createdBy:       isSystem ? null : toP(session.createdBy),
    participants,
    maxParticipants: session.maxParticipants,
    isUrgent:        session.isBoosted     || false,
    isBoosted:       session.isBoosted     || false,
    isSystemGenerated: isSystem,
    status:          session.status,
    chatId:          session.chatId?.toString() || null,
    distance:        distanceMeters !== null ? Math.round(distanceMeters) : null,
    spotsLeft:       session.maxParticipants - participants.length,
    isCreator:       currentUserId ? creatorId === currentUserId.toString() : false,
    hasJoined:       currentUserId ? participants.some(p => p.id === currentUserId.toString()) : false
  };
}

// ─── Fetch trending TMDB movies (cached) ─────────────────────────────────────
async function fetchTrendingMovies() {
  const now = Date.now();
  if (moviesCache.data && (now - moviesCache.timestamp) < CACHE_TTL_MS) {
    return moviesCache.data;
  }

  const TMDB_KEY = process.env.TMDB_API_KEY;
  if (!TMDB_KEY) return [];

  try {
    const params = new URLSearchParams({
      api_key:            TMDB_KEY,
      region:             'IN',
      sort_by:            'popularity.desc',
      with_release_type:  '2|3',
      'release_date.gte': '2024-01-01',
      'vote_count.gte':   '100',
      language:           'en-IN',
      page:               '1'
    });

    const res  = await fetch(`https://api.themoviedb.org/3/discover/movie?${params}`);
    const data = await res.json();

    const movies = (data.results || []).slice(0, 20).map(m => ({
      id:         m.id,
      title:      m.title,
      posterPath: m.poster_path || null,
      rating:     Math.round(m.vote_average * 10) / 10,
      overview:   m.overview || ''
    }));

    moviesCache = { data: movies, timestamp: now };
    return movies;
  } catch {
    return moviesCache.data || [];
  }
}

// ─── Fetch nearby theatres from Google Places ─────────────────────────────────
async function fetchNearbyTheatres(lat, lng, radius = 8000) {
  const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!PLACES_KEY || lat === null || lng === null) return [];

  try {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
      `?location=${lat},${lng}&radius=${radius}&type=movie_theater&key=${PLACES_KEY}`;

    const res  = await fetch(url);
    const data = await res.json();

    return (data.results || []).map(p => ({
      placeId: p.place_id,
      name:    p.name,
      address: p.vicinity || '',
      rating:  p.rating || null,
      distance: Math.round(haversineDistance(lat, lng, p.geometry.location.lat, p.geometry.location.lng)),
      lat:     p.geometry.location.lat,
      lng:     p.geometry.location.lng
    })).sort((a, b) => a.distance - b.distance);
  } catch {
    return [];
  }
}

// ─── Auto-generate system sessions ───────────────────────────────────────────
async function generateSystemSessions(userCtx, lat, lng) {
  const [movies, theatres] = await Promise.all([
    fetchTrendingMovies(),
    fetchNearbyTheatres(lat, lng)
  ]);

  if (!movies.length || !theatres.length) return;

  const now          = new Date();
  const userLang     = userCtx.languagePreference;
  const langPool     = [userLang, 'Hindi', 'English', 'Tamil'].filter((v, i, a) => a.indexOf(v) === i);
  const created      = [];

  for (let i = 0; i < Math.min(3, movies.length); i++) {
    const movie   = movies[i];
    const theatre = theatres[i % theatres.length];

    // Assign language: first session always matches user's language
    const lang    = i === 0 ? userLang : (langPool[i % langPool.length] || DEFAULT_LANGUAGE);

    // Show time: 30–90 min from now
    const offsetMin   = 30 + i * 20;                        // 30, 50, 70 minutes
    const showTime    = new Date(now.getTime() + offsetMin * 60_000);
    const expiresAt   = new Date(showTime.getTime() +  15 * 60_000); // +15 min
    const chatExpAt   = new Date(showTime.getTime() + 180 * 60_000); // +3 hrs

    const dateStr = showTime.toISOString().slice(0, 10);
    const timeStr = showTime.toTimeString().slice(0, 5);

    // Duplicate guard: same movie + theatre + date + time
    const exists = await MovieSession.exists({
      movieId: movie.id.toString(),
      theatreName: theatre.name,
      date: dateStr,
      time: timeStr,
      status: 'active'
    });
    if (exists) continue;

    // Create chat
    const chat = await MovieChat.create({
      sessionId: null,
      participants: [],
      messages: [],
      expiresAt: chatExpAt,
      status: 'active'
    });

    // Simulated participant count (1 or 2 out of 4) — NO fake user IDs
    const fakeParticipantCount = i === 0 ? 2 : 1;

    const session = await MovieSession.create({
      movieId:         movie.id.toString(),
      movieTitle:      movie.title,
      poster:          movie.posterPath,
      language:        lang,
      theatreName:     theatre.name,
      theatreAddress:  theatre.address,
      theatrePlaceId:  theatre.placeId,
      theatreLocation: { type: 'Point', coordinates: [theatre.lng, theatre.lat] },
      date:            dateStr,
      time:            timeStr,
      showTime,
      expiresAt,
      chatExpiresAt: chatExpAt,
      createdBy:       'system',
      participants:    [],                       // real array is empty
      simulatedParticipants: fakeParticipantCount,  // display-only count
      maxParticipants: 4,
      isBoosted:       false,
      isSystemGenerated: true,
      status:          'active',
      chatId:          chat._id
    });

    chat.sessionId = session._id;
    await chat.save();
    created.push(session._id);
  }

  console.log(`🎬 System generated ${created.length} movie session(s)`);
}

// =============================================================================
// GET /api/movies
// =============================================================================
exports.getMovies = async (req, res) => {
  try {
    const movies = await fetchTrendingMovies();
    return res.json({ success: true, movies, cached: moviesCache.timestamp > 0 });
  } catch (err) {
    console.error('getMovies error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/theatres?lat=&lng=&radius=
//
// lat/lng are OPTIONAL — falls back to user's DB-stored location
// =============================================================================
exports.getNearbyTheatres = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.userId;
    const { radius = 8000 } = req.query;

    // ── Resolve location: query → DB ──────────────────────────────────────────
    const loc = await resolveLocation(req.query.lat, req.query.lng, userId);

    if (loc.lat === null || loc.lng === null) {
      return res.status(400).json({
        success: false,
        message:  'Location not available. Please allow location permission in the app.'
      });
    }

    console.log(`📍 Theatre search using ${loc.source} location: (${loc.lat}, ${loc.lng})`);

    const theatres = await fetchNearbyTheatres(loc.lat, loc.lng, parseInt(radius));

    return res.json({
      success: true,
      locationSource: loc.source,
      theatres
    });

  } catch (err) {
    console.error('getNearbyTheatres error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// POST /api/movie-session/create
//
// Language comes ONLY from user.questionnaire.languagePreference — never frontend
// =============================================================================
exports.createSession = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.userId;

    const {
      movieId, title, posterPath, overview, rating,
      theatreName, theatreAddress, theatrePlaceId,
      theatreLat, theatreLng,
      date, time, maxParticipants, isUrgent
    } = req.body;

    // ── Validation ────────────────────────────────────────────────────────────
    if (!movieId || !title || !theatreName || !theatreAddress || !date || !time) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    if (!theatreLat || !theatreLng) {
      return res.status(400).json({ success: false, message: 'Theatre location required' });
    }

    // ── Fetch language from user profile ──────────────────────────────────────
    const userCtx = await fetchUserContext(userId);
    const language = userCtx?.languagePreference || DEFAULT_LANGUAGE;
    console.log(`🌐 Session language set from profile: "${language}"`);

    // ── Parse showTime ────────────────────────────────────────────────────────
    const [year, month, day] = date.split('-').map(Number);
    const [hours, minutes]   = time.split(':').map(Number);
    const showTime    = new Date(year, month - 1, day, hours, minutes, 0);

    if (isNaN(showTime.getTime()) || showTime <= new Date()) {
      return res.status(400).json({ success: false, message: 'Show time must be in the future' });
    }

    const expiresAt   = new Date(showTime.getTime() +  15 * 60_000);  // +15 min (card disappears)
    const chatExpAt   = new Date(showTime.getTime() + 180 * 60_000);  // +3 hrs

    // ── Duplicate guard ───────────────────────────────────────────────────────
    const duplicate = await MovieSession.findOne({
      createdBy: userId, movieId: movieId.toString(), date, time, status: 'active'
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active session for this movie at the same time'
      });
    }

    // ── Create chat ───────────────────────────────────────────────────────────
    const chat = await MovieChat.create({
      sessionId:    null,
      participants: [userId],
      messages:     [],
      expiresAt:    chatExpAt,
      status:       'active'
    });

    // ── Create session ────────────────────────────────────────────────────────
    const session = await MovieSession.create({
      movieId:         movieId.toString(),
      movieTitle:      title,
      poster:          posterPath || null,
      language,                              // ← from profile, not frontend
      theatreName,
      theatreAddress,
      theatrePlaceId:  theatrePlaceId || null,
      theatreLocation: {
        type:        'Point',
        coordinates: [parseFloat(theatreLng), parseFloat(theatreLat)]
      },
      date, time, showTime, expiresAt,
      chatExpiresAt:    chatExpAt,
      createdBy:        userId,
      participants:     [userId],
      maxParticipants:  parseInt(maxParticipants) || 5,
      isBoosted:        Boolean(isUrgent),
      isSystemGenerated: false,
      status:           'active',
      chatId:           chat._id
    });

    chat.sessionId = session._id;
    await chat.save();

    const populated = await MovieSession.findById(session._id)
      .populate('createdBy', 'firstName lastName profilePhoto')
      .populate('participants', 'firstName lastName profilePhoto');

    return res.status(201).json({
      success: true,
      session: formatSession(populated, userId)
    });

  } catch (err) {
    console.error('createSession error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// =============================================================================
// GET /api/movie-session/nearby?lat=&lng=
//
// lat/lng optional — falls back to DB location
// Auto-fills with system sessions if < 2 found
// Sorted by: language match → boosted → distance → time → fill %
// =============================================================================
exports.getNearbySessions = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.userId;
    const now    = new Date();

    // ── Resolve location ──────────────────────────────────────────────────────
    const loc = await resolveLocation(req.query.lat, req.query.lng, userId);

    // ── Fetch user language preference ────────────────────────────────────────
    const userCtx  = await fetchUserContext(userId);
    const userLang = userCtx?.languagePreference || DEFAULT_LANGUAGE;

    // ── Build query ───────────────────────────────────────────────────────────
    const baseQuery = { status: 'active', expiresAt: { $gt: now } };
    const MAX_RADIUS_M = 20000;

    let sessions;
    if (loc.lat !== null && loc.lng !== null) {
      sessions = await MovieSession.find({
        ...baseQuery,
        theatreLocation: {
          $nearSphere: {
            $geometry:   { type: 'Point', coordinates: [loc.lng, loc.lat] },
            $maxDistance: MAX_RADIUS_M
          }
        }
      })
        .populate('createdBy', 'firstName lastName profilePhoto')
        .populate('participants', 'firstName lastName profilePhoto')
        .limit(30);
    } else {
      sessions = await MovieSession.find(baseQuery)
        .populate('createdBy', 'firstName lastName profilePhoto')
        .populate('participants', 'firstName lastName profilePhoto')
        .sort({ createdAt: -1 })
        .limit(20);
    }

    // ── Auto-generate system sessions if feed is sparse ───────────────────────
    if (sessions.length < 2 && loc.lat !== null && loc.lng !== null && userCtx) {
      console.log('🤖 Sparse feed — generating system sessions...');
      await generateSystemSessions(userCtx, loc.lat, loc.lng);

      // Re-fetch after generating
      if (loc.lat !== null) {
        sessions = await MovieSession.find({
          ...baseQuery,
          theatreLocation: {
            $nearSphere: {
              $geometry:   { type: 'Point', coordinates: [loc.lng, loc.lat] },
              $maxDistance: MAX_RADIUS_M
            }
          }
        })
          .populate('createdBy', 'firstName lastName profilePhoto')
          .populate('participants', 'firstName lastName profilePhoto')
          .limit(30);
      }
    }

    // ── Format + score ────────────────────────────────────────────────────────
    const formatted = sessions.map(s => {
      const dist = (loc.lat !== null) ? haversineDistance(
        loc.lat, loc.lng,
        s.theatreLocation.coordinates[1],
        s.theatreLocation.coordinates[0]
      ) : null;

      // For system sessions: use simulatedParticipants for display
      const displaySession = s.toObject();
      if (s.isSystemGenerated && s.simulatedParticipants > 0) {
        displaySession.participants = Array(s.simulatedParticipants).fill({ id: 'system', firstName: '' });
      }

      const score = scoreSession(s, now, userLang, loc.lat, loc.lng);
      return {
        ...formatSession(displaySession, userId, dist),
        _score: score
      };
    });

    // ── Sort: language-match sessions first, then by score ────────────────────
    const langMatch  = formatted.filter(s => s.language === userLang).sort((a, b) => b._score - a._score);
    const otherLang  = formatted.filter(s => s.language !== userLang).sort((a, b) => b._score - a._score);
    const sorted     = [...langMatch, ...otherLang].slice(0, 10);

    sorted.forEach(s => delete s._score);

    return res.json({
      success: true,
      userLanguage: userLang,
      sessions: sorted
    });

  } catch (err) {
    console.error('getNearbySessions error:', err);
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

    if (session.status === 'expired' || new Date() > session.expiresAt) {
      return res.status(400).json({ success: false, message: 'This session has expired' });
    }

    const alreadyJoined = session.participants.some(p => p.toString() === userId.toString());
    if (alreadyJoined) {
      return res.json({ success: true, message: 'Already a member', chatId: session.chatId?.toString() || null });
    }

    if (session.participants.length >= session.maxParticipants) {
      return res.status(400).json({ success: false, message: 'Session is full' });
    }

    // First real join on a system session — clear simulated count
    if (session.isSystemGenerated && session.participants.length === 0) {
      session.simulatedParticipants = 0;
    }

    session.participants.push(userId);
    await session.save();

    // Add to chat
    const chat = await MovieChat.findById(session.chatId);
    if (chat) {
      const inChat = chat.participants.some(p => p.toString() === userId.toString());
      if (!inChat) { chat.participants.push(userId); await chat.save(); }
    }

    // Notify creator via socket
    try {
      const io   = req.app.get('io');
      const User = mongoose.model('User');
      const joiner = await User.findById(userId).select('firstName lastName');
      if (session.createdBy && session.createdBy.toString() !== 'system') {
        io.to(`user-${session.createdBy}`).emit('movie-session-joined', {
          sessionId:    session._id.toString(),
          joinerName:   joiner ? `${joiner.firstName} ${joiner.lastName || ''}`.trim() : 'Someone',
          movieTitle:   session.movieTitle,
          participants: session.participants.length
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
    const sessionId = req.params.id;

    const session = await MovieSession.findById(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const isMember = session.participants.some(p => p.toString() === userId.toString());
    if (!isMember) return res.status(403).json({ success: false, message: 'Not a member' });

    const chat = await MovieChat.findById(session.chatId);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

    return res.json({
      success: true,
      chat: {
        id:           chat._id.toString(),
        sessionId:    chat.sessionId.toString(),
        participants: chat.participants.map(p => p.toString()),
        messages:     chat.messages.map(m => ({
          senderId:    m.senderId.toString(),
          senderName:  m.senderName,
          senderPhoto: m.senderPhoto || null,
          text:        m.text,
          timestamp:   m.timestamp.toISOString()
        })),
        expiresAt: chat.expiresAt.toISOString(),
        status:    chat.status
      }
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
    const userId    = req.user?.id || req.user?._id || req.userId;
    const sessionId = req.params.id;
    const { text }  = req.body;

    if (!text?.trim()) return res.status(400).json({ success: false, message: 'Message text required' });

    const session = await MovieSession.findById(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const isMember = session.participants.some(p => p.toString() === userId.toString());
    if (!isMember) return res.status(403).json({ success: false, message: 'Not a member' });

    const chat = await MovieChat.findById(session.chatId);
    if (!chat || chat.status === 'expired') {
      return res.status(400).json({ success: false, message: 'Chat no longer available' });
    }

    const User   = mongoose.model('User');
    const sender = await User.findById(userId).select('firstName lastName profilePhoto');
    const msg    = {
      senderId:    userId,
      senderName:  sender ? `${sender.firstName} ${sender.lastName || ''}`.trim() : 'User',
      senderPhoto: sender?.profilePhoto || null,
      text:        text.trim(),
      timestamp:   new Date()
    };

    chat.messages.push(msg);
    await chat.save();

    try {
      const io = req.app.get('io');
      io.to(`movie-chat-${chat._id}`).emit('movie-new-message', {
        senderId:    userId.toString(),
        senderName:  msg.senderName,
        senderPhoto: msg.senderPhoto,
        text:        msg.text,
        timestamp:   msg.timestamp.toISOString()
      });
    } catch (_) { /* non-critical */ }

    return res.json({ success: true, message: 'Message sent' });

  } catch (err) {
    console.error('sendMessage error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
