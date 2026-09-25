// utils/sportsImageConfig.js
// -----------------------------------------------------------------------------
// Sports & Fitness — one piece of artwork per sport, returned with every Sports
// plan as `sportImageUrl`. The same idea as TOPIC_IMAGES in roomTopicConfig.js:
// the URL lives on the server, so adding or replacing a sport's image means
// editing this file and deploying the backend — never an app release.
//
// The app shows the image on the Plans Near You card and as the header of the
// plan screen. Without one (null, or an entry that is not a valid https URL) it
// draws its own built-in sport icon and background instead.
//
// Asset spec — one image serves both places:
//   • landscape 16:9, 1600 × 900 px, WebP
//   • no text, no logos, no people
//   • opaque (the app draws its fallback underneath while the image loads)
//
// Replacing an image: upload it under a NEW file name (basketball-v2.webp) and
// point the entry at it. Phones cache images by URL, so overwriting the old file
// in place can keep showing the old picture for a long time.
//
// Clients can never set this: the create request does not read it, it is not
// stored on the plan, and it is looked up here from the sport at response time.
// -----------------------------------------------------------------------------
'use strict';

// Keys must match SPORT_TYPES in services/sportsPlanService.js.
const SPORT_IMAGES = Object.freeze({
  badminton:    "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/badminton.webp",
  football:     "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/Football.webp",
  cricket:      "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/circket.webp",
  basketball:   "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/basketball.webp",
  tennis:       "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/tennis.webp",
  table_tennis: "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/table_tennis.webp",
  running:      "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/running.webp",
  cycling:      "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/cycling.webp",
  gym:          "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/gym.webp",
  yoga:         "https://pub-6b15ba7242804a5ba9ca9ed1115c2810.r2.dev/sport-topic/yoga.webp",
});

const MAX_URL_LENGTH = 2048;

/**
 * @returns {?string} the URL, normalised, if it is an absolute https URL with a
 *   host and no embedded credentials; otherwise null.
 */
function safeImageUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url.href;
}

/** Validates a sport → URL table once, so a typo here can never reach a phone. */
function buildImageTable(table) {
  const out = {};
  for (const [sport, value] of Object.entries(table || {})) {
    const url = safeImageUrl(value);
    if (!url && value != null && value !== '') {
      console.warn(`[sportsImageConfig] ignoring the image for "${sport}": not a valid https URL`);
    }
    out[sport] = url;
  }
  return Object.freeze(out);
}

const RESOLVED = buildImageTable(SPORT_IMAGES);

/** @returns {?string} the sport's artwork URL, or null when none is configured. */
function resolveSportImageUrl(sportType) {
  if (typeof sportType !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(RESOLVED, sportType) ? RESOLVED[sportType] : null;
}

module.exports = {
  SPORT_IMAGES,
  resolveSportImageUrl,
  safeImageUrl,
  buildImageTable,
};
