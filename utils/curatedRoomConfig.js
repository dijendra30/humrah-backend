// utils/curatedRoomConfig.js
// -----------------------------------------------------------------------------
// Rooms Phase 2.2 — durable public topic Rooms hosted by Humrah ("curated" Rooms).
//
// WHY: Room inventory is short-lived by design (ACTIVE -> INACTIVE after 24h
// without a message, CLOSED 48h later) and production had 0 open Rooms on
// 5 Nov 2026 (read-only inventory: 54 Rooms, all CLOSED). Curated Rooms give
// discovery a small, honest, always-open set of public topic Rooms.
//
// HONESTY RULES (enforced by tests, not just by convention):
//   - creationSource 'CURATED', no createdBy: there is no human host to pretend to be.
//   - Seeded with memberCount 0, lastMessageAt null, NO messages, NO members.
//     Every count shown for them is the real JOINED count.
//   - Copy describes what the Room is for; it never claims activity or people.
//
// CAPACITY: curated Rooms hold up to 25 (user-approved, 5 Nov 2026). User and
// SYSTEM Rooms keep their existing 2–5 limit.
//
// THE TOPIC LIST BELOW was approved by the product owner on 5 Nov 2026 (all 10, as
// listed). Every topic is one of roomTopicConfig.GLOBAL_TOPICS (tests enforce it).
// Changing the list only affects future seed runs: the seed is insert-only and
// never edits or removes an existing Room. Approving the list is not approval to
// seed production; that remains a separate step.
// -----------------------------------------------------------------------------
'use strict';

const CREATION_SOURCE_CURATED = 'CURATED';
const USER_ROOM_MAX_CAPACITY = 5;
const CURATED_ROOM_CAPACITY = 25;

/** Max capacity the schema allows for a Room of this creationSource. */
function maxCapacityFor(creationSource) {
  return creationSource === CREATION_SOURCE_CURATED ? CURATED_ROOM_CAPACITY : USER_ROOM_MAX_CAPACITY;
}

const isCuratedRoom = (room) => Boolean(room) && room.creationSource === CREATION_SOURCE_CURATED;

// key: stable idempotency key (stored as HumrahRoom.curatedTopicKey, unique).
// title: <= 30 chars (HumrahRoom.title maxlength). description: <= 200 chars.
const CURATED_ROOMS = Object.freeze([
  { key: 'just-meeting-new-people', topic: 'Just Meeting New People', title: 'Just Meeting New People',
    description: 'A public Room hosted by Humrah for saying hello and getting to know new people. Be kind and keep it friendly.' },
  { key: 'chill-casual-conversations', topic: 'Chill & Casual Conversations', title: 'Chill & Casual Conversations',
    description: 'A public Room hosted by Humrah for easy, low-pressure chat about anything and everything.' },
  { key: 'movies-series', topic: 'Movies & Series', title: 'Movies & Series',
    description: 'A public Room hosted by Humrah for talking about films and shows: recommendations, reviews and what to watch next.' },
  { key: 'music', topic: 'Music', title: 'Music',
    description: 'A public Room hosted by Humrah for sharing songs, artists and gigs you love.' },
  { key: 'food-cooking', topic: 'Food & Cooking', title: 'Food & Cooking',
    description: 'A public Room hosted by Humrah for recipes, favourite dishes and places to eat.' },
  { key: 'travel-exploring', topic: 'Travel & Exploring', title: 'Travel & Exploring',
    description: 'A public Room hosted by Humrah for trips, travel tips and places worth exploring.' },
  { key: 'gaming', topic: 'Gaming', title: 'Gaming',
    description: 'A public Room hosted by Humrah for games you play, want to play, or want company for.' },
  { key: 'sports', topic: 'Sports', title: 'Sports',
    description: 'A public Room hosted by Humrah for matches, teams and staying active together.' },
  { key: 'career-work', topic: 'Career & Work', title: 'Career & Work',
    description: 'A public Room hosted by Humrah for work life, career questions and advice.' },
  { key: 'books-reading', topic: 'Books & Reading', title: 'Books & Reading',
    description: 'A public Room hosted by Humrah for books you are reading and ones you would recommend.' },
]);

module.exports = {
  CREATION_SOURCE_CURATED,
  USER_ROOM_MAX_CAPACITY,
  CURATED_ROOM_CAPACITY,
  CURATED_ROOMS,
  maxCapacityFor,
  isCuratedRoom,
};
