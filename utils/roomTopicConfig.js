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
  'Movies & Series': null,
  'Food & Cooking': null,
  'Music': null,
  'Gaming': null,
  'Travel & Exploring': null,
  'Sports': null,
  'Study & Learning': null,
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
  'Delhi Dairy': null
};

const LOCATION_TOPICS = {
  'Delhi': ['Delhi Dairy']
};

function resolveRoomTopicImage(topic) {
  if (!topic) return DEFAULT_IMAGE_URL;
  const url = TOPIC_IMAGES[topic];
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

function isValidTopicForUser(topic, city) {
  if (GLOBAL_TOPICS.includes(topic)) return true;
  if (city && LOCATION_TOPICS[city] && LOCATION_TOPICS[city].includes(topic)) return true;
  return false;
}

module.exports = {
  DEFAULT_IMAGE_URL,
  GLOBAL_TOPICS,
  resolveRoomTopicImage,
  getAvailableTopics,
  isValidTopicForUser
};
