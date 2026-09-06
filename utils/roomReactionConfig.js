// utils/roomReactionConfig.js
// Backend-authoritative emoji allowlist for Humrah Room message reactions.
// Android must use this same set; anything else is rejected.
'use strict';

const ALLOWED_REACTIONS = ['❤️', '😂', '👍', '👏', '🔥', '😍', '😮', '😢'];
const ALLOWED_SET = new Set(ALLOWED_REACTIONS);

/**
 * Validates a client-supplied reaction. Guards against arbitrary/oversized strings.
 * @returns {string|null} the canonical emoji, or null when unsupported.
 */
function normalizeReaction(emoji) {
  if (typeof emoji !== 'string') return null;
  const trimmed = emoji.trim();
  if (trimmed.length === 0 || trimmed.length > 8) return null; // emoji + VS16 fits easily
  return ALLOWED_SET.has(trimmed) ? trimmed : null;
}

/** Public shape for API responses: [{ emoji, count, reacted }] */
function serializeReactions(reactions, viewerId) {
  const viewer = viewerId ? String(viewerId) : null;
  return (reactions || [])
    .filter(r => r && r.emoji && Array.isArray(r.userIds) && r.userIds.length > 0)
    .map(r => ({
      emoji: r.emoji,
      count: r.userIds.length,
      reacted: viewer ? r.userIds.some(id => String(id) === viewer) : false,
    }));
}

module.exports = { ALLOWED_REACTIONS, normalizeReaction, serializeReactions };
