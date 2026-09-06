const DEFAULT_IMAGE_URL = 'https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/room-topics/default.png';

const GLOBAL_TOPICS = [
  'Movies & Series', 'Food & Cooking', 'Music', 'Gaming', 'Travel & Exploring',
  'Sports', 'Study & Learning', 'Books & Reading', 'Technology', 'Photography & Content Creation',
  'Fitness & Wellness', 'Fashion & Style', 'Art & Creativity', 'Career & Work', 'Startups & Business',
  'College & Campus Life', 'Current Topics', 'Life & Experiences', 'Personal Growth', 'Relationships & Friendships',
  'Chill & Casual Conversations', 'Deep Conversations', 'Local Hangouts', 'Cafés & Food Spots', 'Weekend Plans',
  'City Exploration', 'Events & Activities', 'Random Fun Discussions', 'Memes & Internet Culture', 'Pop Culture',
  'Anime & Manga', 'TV Shows & Fandoms', 'Creative Writing & Storytelling', 'Language & Culture', 'Just Meeting New People'
];

const TOPIC_IMAGES = {
  'Movies & Series': 'https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/room-topics/Movies%20%26%20Series.png',
  'Food & Cooking': 'https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/room-topics/Food%20%26%20Cooking.png',
  'Music': 'https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/room-topics/Music.png',
  'Gaming': 'https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/room-topics/Gaming.png',
  'Travel & Exploring': 'https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/room-topics/Travel%20%26%20Exploring.png',
  'Sports': 'https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/room-topics/Sports.png',
  'Study & Learning': 'https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/room-topics/Study%20%26%20Learning.png',
  'Books & Reading': null,
  'Technology': null,
  'Photography & Content Creation': null,
  'Fitness & Wellness': null,
  'Fashion & Style': null,
  'Art & Creativity': null,
  'Career & Work': null,
  'Startups & Business': null,
  'College & Campus Life': null,
  'Current Topics': null,
  'Life & Experiences': null,
  'Personal Growth': null,
  'Relationships & Friendships': null,
  'Chill & Casual Conversations': null,
  'Deep Conversations': null,
  'Local Hangouts': null,
  'Cafés & Food Spots': null,
  'Weekend Plans': null,
  'City Exploration': null,
  'Events & Activities': null,
  'Random Fun Discussions': null,
  'Memes & Internet Culture': null,
  'Pop Culture': null,
  'Anime & Manga': null,
  'TV Shows & Fandoms': null,
  'Creative Writing & Storytelling': null,
  'Language & Culture': null,
  'Just Meeting New People': null,

  // Location-specific topics
  'Delhi Dairy': 'https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/room-topics/Delhi%20Dairy.png'
};

const LOCATION_TOPICS = {
  'Delhi': ['Delhi Dairy']
};

// -----------------------------------------------------------------------------
// Canonical topic resolution.
//
// The progressive questionnaire (Q24) historically shipped the same 35 topics in
// sentence case ("Food & cooking") while this file — and the Room creation flow —
// use title case ("Food & Cooking"). 31 of the 35 differed by capitalisation only.
// Because every topic comparison in the backend is an exact string match, those
// answers were treated as unknown topics: System Room generation could never find
// a shared topic, and topic-based matching/discovery scoring silently under-fired.
//
// canonicalizeTopic() is the single place that resolves any stored spelling to the
// canonical one. It is intentionally conservative: it matches on case and
// whitespace only, never on meaning, and returns null for anything it does not
// recognise so unknown topics can still be rejected.
// -----------------------------------------------------------------------------
const CANONICAL_BY_KEY = (() => {
  const map = new Map();
  const key = (t) => String(t).trim().toLowerCase().replace(/\s+/g, ' ');
  GLOBAL_TOPICS.forEach(t => map.set(key(t), t));
  Object.values(LOCATION_TOPICS).forEach(list => list.forEach(t => map.set(key(t), t)));
  return map;
})();

/**
 * @param {string} topic any stored/received topic spelling
 * @returns {?string} the canonical topic string, or null if unrecognised
 */
function canonicalizeTopic(topic) {
  if (typeof topic !== 'string') return null;
  const k = topic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!k) return null;
  return CANONICAL_BY_KEY.get(k) || null;
}

/**
 * Canonicalizes a list of topics, dropping unrecognised entries and duplicates
 * that collapse onto the same canonical topic. Order is preserved.
 */
function canonicalizeTopics(topics) {
  const out = [];
  const seen = new Set();
  (Array.isArray(topics) ? topics : []).forEach(t => {
    const c = canonicalizeTopic(t);
    if (c && !seen.has(c)) { seen.add(c); out.push(c); }
  });
  return out;
}

function resolveRoomTopicImage(topic) {
  if (!topic) return DEFAULT_IMAGE_URL;
  const url = TOPIC_IMAGES[canonicalizeTopic(topic) || topic];
  if (url && url.trim() !== '') {
    return url;
  }
  return DEFAULT_IMAGE_URL;
}

function getAvailableTopics(city) {
  const local = (city && LOCATION_TOPICS[city]) ? LOCATION_TOPICS[city] : [];
  return {
    global: GLOBAL_TOPICS.map(t => ({
      topic: t,
      type: 'GLOBAL',
      imageUrl: resolveRoomTopicImage(t)
    })),
    local: local.map(t => ({
      topic: t,
      type: 'LOCATION',
      location: city,
      imageUrl: resolveRoomTopicImage(t)
    }))
  };
}

// Accepts any casing/whitespace variant of a real topic; still rejects unknown
// topics, and still enforces that a LOCATION topic belongs to the user's city.
function isValidTopicForUser(topic, city) {
  const canonical = canonicalizeTopic(topic);
  if (!canonical) return false;
  if (GLOBAL_TOPICS.includes(canonical)) return true;
  if (city && LOCATION_TOPICS[city] && LOCATION_TOPICS[city].includes(canonical)) return true;
  return false;
}

module.exports = {
  DEFAULT_IMAGE_URL,
  GLOBAL_TOPICS,
  LOCATION_TOPICS,
  resolveRoomTopicImage,
  getAvailableTopics,
  isValidTopicForUser,
  canonicalizeTopic,
  canonicalizeTopics
};
