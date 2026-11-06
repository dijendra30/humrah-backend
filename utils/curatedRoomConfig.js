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
//   - Copy describes what the Room is for, in a person's voice; it never claims
//     activity or people. Hosting is disclosed by creationSource ('CURATED'),
//     which the app shows as "Hosted by Humrah", so the copy doesn't repeat it.
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
    description: 'New here, or just up for meeting someone new? Say hi and tell us a little about yourself.' },
  { key: 'chill-casual-conversations', topic: 'Chill & Casual Conversations', title: 'Chill & Casual Conversations',
    description: "No agenda. How your day went, a random thought, what you had for lunch. Whatever's on your mind." },
  { key: 'movies-series', topic: 'Movies & Series', title: 'Movies & Series',
    description: 'What are you watching right now? Recommendations, rewatches, and the endings worth arguing about.' },
  { key: 'music', topic: 'Music', title: 'Music',
    description: "Songs on repeat, artists you'd queue for, and gigs worth the trip." },
  { key: 'food-cooking', topic: 'Food & Cooking', title: 'Food & Cooking',
    description: 'Recipes that actually work, the dish your mom makes best, and where to eat in a new city.' },
  { key: 'travel-exploring', topic: 'Travel & Exploring', title: 'Travel & Exploring',
    description: "Trips you've taken, trips you're planning, and the small places you'd only tell a friend about." },
  { key: 'gaming', topic: 'Gaming', title: 'Gaming',
    description: "What you're playing, what you're stuck on, and finding someone to play with." },
  { key: 'sports', topic: 'Sports', title: 'Sports',
    description: "Match days, the team you can't give up on, and getting out to play yourself." },
  { key: 'career-work', topic: 'Career & Work', title: 'Career & Work',
    description: "Job hunts, first jobs, difficult bosses and good advice. Ask what you'd hesitate to ask at work." },
  { key: 'books-reading', topic: 'Books & Reading', title: 'Books & Reading',
    description: "What's on your nightstand, what you couldn't finish, and the book you keep recommending." },
]);

module.exports = {
  CREATION_SOURCE_CURATED,
  USER_ROOM_MAX_CAPACITY,
  CURATED_ROOM_CAPACITY,
  CURATED_ROOMS,
  maxCapacityFor,
  isCuratedRoom,
};
