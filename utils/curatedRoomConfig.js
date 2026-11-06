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

// Room supply (6 Nov 2026): the product owner approved Humrah-hosted Rooms for ANY of
// the 35 global topics, opened by services/roomSupplyService.js only when there are
// few user Rooms. These are the other 25 topics, same rules as above. They are never
// seeded in bulk: the supply job inserts one only when that topic is chosen.
const SUPPLY_TOPIC_ROOMS = Object.freeze([
  { key: 'technology', topic: 'Technology', title: 'Technology',
    description: "Phones, apps, AI, and the gadget you're thinking of buying. Ask, explain, or argue about it." },
  { key: 'study-learning', topic: 'Study & Learning', title: 'Study & Learning',
    description: "Exams, study plans, and the subject you're finally trying to get. Find someone to study with, or just vent." },
  { key: 'photography-content', topic: 'Photography & Content Creation', title: 'Photography & Content Creation',
    description: 'Your best shots, editing apps, the reel that took ten takes, and how to get better at all of it.' },
  { key: 'fitness-wellness', topic: 'Fitness & Wellness', title: 'Fitness & Wellness',
    description: 'Workouts, walks, sleep, and staying consistent. Share what works for you, no judgement.' },
  { key: 'fashion-style', topic: 'Fashion & Style', title: 'Fashion & Style',
    description: "What you're wearing, what you want to buy, and the outfit you're not sure about. Get a second opinion." },
  { key: 'art-creativity', topic: 'Art & Creativity', title: 'Art & Creativity',
    description: "Drawing, crafts, music you make, anything you create. Share it, even if it isn't finished." },
  { key: 'startups-business', topic: 'Startups & Business', title: 'Startups & Business',
    description: 'Side projects, small businesses, and ideas you want to try. Talk them through with people who get it.' },
  { key: 'college-campus', topic: 'College & Campus Life', title: 'College & Campus Life',
    description: "Classes, hostels, fests, and figuring college out. Ask what you'd ask a senior." },
  { key: 'current-topics', topic: 'Current Topics', title: 'Current Topics',
    description: "What's in the news and what people are talking about this week. Disagree if you like, just keep it respectful." },
  { key: 'life-experiences', topic: 'Life & Experiences', title: 'Life & Experiences',
    description: 'Things that happened to you, good or strange, and what you took away from them.' },
  { key: 'personal-growth', topic: 'Personal Growth', title: 'Personal Growth',
    description: "Habits, goals, and getting a little better each week. Share what you're working on." },
  { key: 'relationships-friendships', topic: 'Relationships & Friendships', title: 'Relationships & Friendships',
    description: "Friends, family, dating, and the conversations that are hard to have. Advice is welcome, judgement isn't." },
  { key: 'deep-conversations', topic: 'Deep Conversations', title: 'Deep Conversations',
    description: 'The questions that keep you up at night. Slow chats and honest answers.' },
  { key: 'local-hangouts', topic: 'Local Hangouts', title: 'Local Hangouts',
    description: 'Where people actually hang out in your city, and the places you keep going back to.' },
  { key: 'cafes-food-spots', topic: 'Cafés & Food Spots', title: 'Cafés & Food Spots',
    description: 'The café you keep going back to and the street food worth the queue. Share your spots.' },
  { key: 'weekend-plans', topic: 'Weekend Plans', title: 'Weekend Plans',
    description: "What are you doing this weekend? Plans, ideas, and whether it's worth leaving the house." },
  { key: 'city-exploration', topic: 'City Exploration', title: 'City Exploration',
    description: 'Markets, old lanes, viewpoints, and the parts of the city most people miss.' },
  { key: 'events-activities', topic: 'Events & Activities', title: 'Events & Activities',
    description: "Concerts, workshops, meetups, and things happening where you live. Share what's on." },
  { key: 'random-fun', topic: 'Random Fun Discussions', title: 'Random Fun Discussions',
    description: 'Would you rather, hot takes, and questions with no right answer.' },
  { key: 'memes-internet', topic: 'Memes & Internet Culture', title: 'Memes & Internet Culture',
    description: "The meme that made your day and the trend you still don't understand." },
  { key: 'pop-culture', topic: 'Pop Culture', title: 'Pop Culture',
    description: 'Celebrities, award shows, and the thing the whole internet has an opinion on this week.' },
  { key: 'anime-manga', topic: 'Anime & Manga', title: 'Anime & Manga',
    description: "What you're watching or reading, your favourite arc, and where a beginner should start." },
  { key: 'tv-shows-fandoms', topic: 'TV Shows & Fandoms', title: 'TV Shows & Fandoms',
    description: "The show you'd defend forever, the theories, and the fandom you belong to." },
  { key: 'creative-writing', topic: 'Creative Writing & Storytelling', title: 'Writing & Storytelling',
    description: "Poems, stories, journals, and drafts you've never shown anyone. Share a line or ask for feedback." },
  { key: 'language-culture', topic: 'Language & Culture', title: 'Language & Culture',
    description: 'The language you are learning, festivals, food, and traditions from where you grew up.' },
]);

/** The approved 10 first (their order is the tie-break), then the other 25. */
const ALL_TOPIC_ROOMS = Object.freeze([...CURATED_ROOMS, ...SUPPLY_TOPIC_ROOMS]);
const TOPIC_ROOM_BY_TOPIC = new Map(ALL_TOPIC_ROOMS.map(e => [e.topic, e]));

/** The Humrah-hosted Room entry for a canonical topic, or null (e.g. location topics). */
const topicRoomEntry = (topic) => TOPIC_ROOM_BY_TOPIC.get(topic) || null;

module.exports = {
  CREATION_SOURCE_CURATED,
  USER_ROOM_MAX_CAPACITY,
  CURATED_ROOM_CAPACITY,
  CURATED_ROOMS,
  SUPPLY_TOPIC_ROOMS,
  ALL_TOPIC_ROOMS,
  topicRoomEntry,
  maxCapacityFor,
  isCuratedRoom,
};
