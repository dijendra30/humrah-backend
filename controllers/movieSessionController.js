// controllers/movieSessionController.js
const mongoose   = require('mongoose');
const MovieSession = require('../models/MovieSession');
const MovieChat    = require('../models/MovieChat');

// ─── In-memory TMDB cache (15 min) ───────────────────────────────────────────
let moviesCache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 15 * 60 * 1000;

// ─── Haversine distance (meters) ─────────────────────────────────────────────
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Score a session for feed ranking ────────────────────────────────────────
function scoreSession(session, now) {
  let score = 0;
  const hoursUntilShow = (new Date(session.showDateTime) - now) / 3600000;
  if (hoursUntilShow > 0 && hoursUntilShow < 4)  score += 50;
  else if (hoursUntilShow >= 4 && hoursUntilShow < 12) score += 25;
  if (session.isUrgent) score += 30;
  if (session.spotsLeft > 0) score += 20;
  const ageHours = (now - new Date(session.createdAt)) / 3600000;
  score += Math.max(0, 10 - ageHours * 2);
  return score;
}

// ─── Shape a session document for the API response ───────────────────────────
function formatSession(session, currentUserId, distanceMeters = null) {
  const toParticipant = (p) => {
    if (typeof p === 'object' && p !== null && p._id) {
      return {
        id:           p._id.toString(),
        firstName:    p.firstName  || '',
        lastName:     p.lastName   || null,
        profilePhoto: p.profilePhoto || null
      };
    }
    return { id: p.toString(), firstName: '', lastName: null, profilePhoto: null };
  };

  const participants = (session.participants || []).map(toParticipant);
  const creatorId    = session.createdBy?._id?.toString() || session.createdBy?.toString() || '';

  return {
    id:             session._id.toString(),
    movieId:        session.movieId,
    title:          session.title,
    posterPath:     session.posterPath,
    overview:       session.overview,
    rating:         session.rating,
    theatreName:    session.theatreName,
    theatreAddress: session.theatreAddress,
    date:           session.date,
    time:           session.time,
    showDateTime:   session.showDateTime?.toISOString() || null,
    expiresAt:      session.expiresAt?.toISOString()    || null,
    chatExpiresAt:  session.chatExpiresAt?.toISOString()|| null,
    createdBy:      session.createdBy ? toParticipant(session.createdBy) : null,
    participants,
    maxParticipants: session.maxParticipants,
    isUrgent:        session.isUrgent,
    status:          session.status,
    chatId:          session.chatId?.toString() || null,
    distance:        distanceMeters !== null ? Math.round(distanceMeters) : null,
    spotsLeft:       session.maxParticipants - participants.length,
    isCreator:       currentUserId ? creatorId === currentUserId.toString() : false,
    hasJoined:       currentUserId ? participants.some(p => p.id === currentUserId.toString()) : false
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/movies
// Fetch trending India movies from TMDB, cached 15 min
// ─────────────────────────────────────────────────────────────────────────────
exports.getMovies = async (req, res) => {
  try {
    const now = Date.now();
    if (moviesCache.data && (now - moviesCache.timestamp) < CACHE_TTL_MS) {
      return res.json({ success: true, movies: moviesCache.data, cached: true });
    }

    const TMDB_KEY = process.env.TMDB_API_KEY;
    if (!TMDB_KEY) {
      return res.status(500).json({ success: false, message: 'TMDB API key not configured' });
    }

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

    const response = await fetch(
      `https://api.themoviedb.org/3/discover/movie?${params.toString()}`
    );

    if (!response.ok) {
      return res.status(502).json({ success: false, message: 'Failed to fetch movies from TMDB' });
    }

    const data = await response.json();
    const movies = (data.results || []).slice(0, 20).map(m => ({
      id:         m.id,
      title:      m.title,
      posterPath: m.poster_path || null,
      rating:     Math.round(m.vote_average * 10) / 10,
      overview:   m.overview || ''
    }));

    moviesCache = { data: movies, timestamp: now };
    return res.json({ success: true, movies });

  } catch (err) {
    console.error('getMovies error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/theatres?lat=&lng=&radius=
// Nearby cinemas via Google Places Nearby Search
// ─────────────────────────────────────────────────────────────────────────────
exports.getNearbyTheatres = async (req, res) => {
  try {
    const { lat, lng, radius = 8000 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    }

    const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
    if (!PLACES_KEY) {
      return res.status(500).json({ success: false, message: 'Google Places API key not configured' });
    }

    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
      `?location=${lat},${lng}&radius=${radius}&type=movie_theater&key=${PLACES_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ success: false, message: 'Failed to fetch theatres' });
    }

    const data = await response.json();

    const theatres = (data.results || []).map(place => {
      const placeLocation = place.geometry?.location || {};
      const placeLat = placeLocation.lat || 0;
      const placeLng = placeLocation.lng || 0;
      const distance = haversineDistance(
        parseFloat(lat), parseFloat(lng), placeLat, placeLng
      );
      return {
        placeId: place.place_id,
        name:    place.name,
        address: place.vicinity || '',
        rating:  place.rating   || null,
        distance: Math.round(distance),
        lat:     placeLat,
        lng:     placeLng
      };
    }).sort((a, b) => a.distance - b.distance);

    return res.json({ success: true, theatres });

  } catch (err) {
    console.error('getNearbyTheatres error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/movie-session/create
// ─────────────────────────────────────────────────────────────────────────────
exports.createSession = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;

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
      return res.status(400).json({ success: false, message: 'Theatre location (lat/lng) is required' });
    }

    // ── Parse showDateTime ────────────────────────────────────────────────────
    const [year, month, day]  = date.split('-').map(Number);
    const [hours, minutes]    = time.split(':').map(Number);
    const showDateTime = new Date(year, month - 1, day, hours, minutes, 0);

    if (isNaN(showDateTime.getTime()) || showDateTime <= new Date()) {
      return res.status(400).json({ success: false, message: 'Show time must be in the future' });
    }

    // ── Duplicate guard ───────────────────────────────────────────────────────
    const duplicate = await MovieSession.findOne({
      createdBy: userId, movieId, date, time, status: 'active'
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active session for this movie at the same time'
      });
    }

    const expiresAt     = new Date(showDateTime.getTime() + 5  * 60 * 1000);       // +5 min
    const chatExpiresAt = new Date(showDateTime.getTime() + 3  * 60 * 60 * 1000);  // +3 hrs

    // ── Create chat first ─────────────────────────────────────────────────────
    const chat = await MovieChat.create({
      sessionId:    null, // filled below
      participants: [userId],
      messages:     [],
      expiresAt:    chatExpiresAt,
      status:       'active'
    });

    // ── Create session ────────────────────────────────────────────────────────
    const session = await MovieSession.create({
      movieId:  movieId.toString(),
      title,
      posterPath:     posterPath   || null,
      overview:       overview     || '',
      rating:         rating       || 0,
      theatreName,
      theatreAddress,
      theatrePlaceId: theatrePlaceId || null,
      theatreLocation: {
        type:        'Point',
        coordinates: [parseFloat(theatreLng), parseFloat(theatreLat)]  // GeoJSON: [lng, lat]
      },
      date, time, showDateTime, expiresAt, chatExpiresAt,
      createdBy:       userId,
      participants:    [userId],
      maxParticipants: parseInt(maxParticipants) || 5,
      isUrgent:        Boolean(isUrgent),
      status:          'active',
      chatId:          chat._id
    });

    // Link chat → session
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/movie-session/nearby?lat=&lng=&radius=
// ─────────────────────────────────────────────────────────────────────────────
exports.getNearbySessions = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { lat, lng, radius = 20000 } = req.query;
    const now = new Date();

    let query = { status: 'active', expiresAt: { $gt: now } };
    let sessions;

    if (lat && lng) {
      // Urgent sessions get wider search radius
      const baseRadius = parseInt(radius);
      sessions = await MovieSession.find({
        ...query,
        theatreLocation: {
          $nearSphere: {
            $geometry:   { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
            $maxDistance: baseRadius
          }
        }
      })
        .populate('createdBy', 'firstName lastName profilePhoto')
        .populate('participants', 'firstName lastName profilePhoto')
        .limit(30);
    } else {
      sessions = await MovieSession.find(query)
        .populate('createdBy', 'firstName lastName profilePhoto')
        .populate('participants', 'firstName lastName profilePhoto')
        .sort({ createdAt: -1 })
        .limit(20);
    }

    // Format with distance and sort by score
    const formatted = sessions.map(s => {
      const dist = (lat && lng) ? haversineDistance(
        parseFloat(lat), parseFloat(lng),
        s.theatreLocation.coordinates[1], s.theatreLocation.coordinates[0]
      ) : null;
      return { ...formatSession(s, userId, dist), _score: scoreSession(s, now) };
    });

    formatted.sort((a, b) => b._score - a._score);
    formatted.forEach(s => delete s._score);

    return res.json({ success: true, sessions: formatted });

  } catch (err) {
    console.error('getNearbySessions error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/movie-session/:id/join
// ─────────────────────────────────────────────────────────────────────────────
exports.joinSession = async (req, res) => {
  try {
    const userId    = req.user.id || req.user._id;
    const sessionId = req.params.id;

    const session = await MovieSession.findById(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    if (session.status === 'expired' || new Date() > session.expiresAt) {
      return res.status(400).json({ success: false, message: 'This session has expired' });
    }

    const alreadyJoined = session.participants.some(p => p.toString() === userId.toString());
    if (alreadyJoined) {
      return res.json({
        success: true,
        message: 'Already a member',
        chatId: session.chatId?.toString() || null
      });
    }

    if (session.participants.length >= session.maxParticipants) {
      return res.status(400).json({ success: false, message: 'Session is full' });
    }

    // Add to session
    session.participants.push(userId);
    await session.save();

    // Add to chat
    const chat = await MovieChat.findById(session.chatId);
    if (chat) {
      const inChat = chat.participants.some(p => p.toString() === userId.toString());
      if (!inChat) {
        chat.participants.push(userId);
        await chat.save();
      }
    }

    // Notify creator via socket if online
    try {
      const io   = req.app.get('io');
      const User = mongoose.model('User');
      const joiner = await User.findById(userId).select('firstName lastName');
      io.to(`user-${session.createdBy}`).emit('movie-session-joined', {
        sessionId:   session._id.toString(),
        joinerName:  joiner ? `${joiner.firstName} ${joiner.lastName || ''}`.trim() : 'Someone',
        movieTitle:  session.title,
        participants: session.participants.length
      });
    } catch (_) { /* non-critical */ }

    return res.json({
      success: true,
      message: 'Joined successfully',
      chatId:  session.chatId?.toString() || null
    });

  } catch (err) {
    console.error('joinSession error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/movie-session/:id/chat
// ─────────────────────────────────────────────────────────────────────────────
exports.getSessionChat = async (req, res) => {
  try {
    const userId    = req.user.id || req.user._id;
    const sessionId = req.params.id;

    const session = await MovieSession.findById(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const isMember = session.participants.some(p => p.toString() === userId.toString());
    if (!isMember) {
      return res.status(403).json({ success: false, message: 'You are not a member of this session' });
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/movie-session/:id/chat/message
// ─────────────────────────────────────────────────────────────────────────────
exports.sendMessage = async (req, res) => {
  try {
    const userId    = req.user.id || req.user._id;
    const sessionId = req.params.id;
    const { text }  = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'Message text is required' });
    }

    const session = await MovieSession.findById(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const isMember = session.participants.some(p => p.toString() === userId.toString());
    if (!isMember) {
      return res.status(403).json({ success: false, message: 'Not a member of this session' });
    }

    const chat = await MovieChat.findById(session.chatId);
    if (!chat || chat.status === 'expired') {
      return res.status(400).json({ success: false, message: 'Chat is no longer available' });
    }

    const User   = mongoose.model('User');
    const sender = await User.findById(userId).select('firstName lastName profilePhoto');

    const message = {
      senderId:    userId,
      senderName:  sender ? `${sender.firstName} ${sender.lastName || ''}`.trim() : 'User',
      senderPhoto: sender?.profilePhoto || null,
      text:        text.trim(),
      timestamp:   new Date()
    };

    chat.messages.push(message);
    await chat.save();

    // Emit to socket room so online members get it instantly
    try {
      const io = req.app.get('io');
      io.to(`movie-chat-${chat._id.toString()}`).emit('movie-new-message', {
        senderId:    userId.toString(),
        senderName:  message.senderName,
        senderPhoto: message.senderPhoto,
        text:        message.text,
        timestamp:   message.timestamp.toISOString()
      });
    } catch (_) { /* non-critical */ }

    return res.json({ success: true, message: 'Message sent' });

  } catch (err) {
    console.error('sendMessage error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
