// services/engagement/sources/index.js
// The opportunity sources. Each exposes collect(ctx) → opportunities and
// revalidate(doc, user, now, cfg) → { ok, reason } used just before sending.
// Adding a category later = adding a source here; the planner and processor do not change.
'use strict';

const nearbyMembers = require('./nearbyMembers');
const sportsPlans = require('./sportsPlans');
const humrahRooms = require('./humrahRooms');
const communityQuestions = require('./communityQuestions');
const catalogSource = require('./catalogSource');

const SOURCES = Object.freeze([nearbyMembers, sportsPlans, humrahRooms, communityQuestions, catalogSource]);
const BY_EVENT_TYPE = Object.freeze(Object.fromEntries(SOURCES.map(s => [s.eventType, s])));

/**
 * Runs every source whose category is enabled. One failing source never stops the
 * others; its failure is returned as a reason code for the log.
 */
async function collectAll(ctx) {
  const enabled = new Set(ctx.cfg.enabledCategories);
  const opportunities = [];
  const errors = [];
  for (const s of SOURCES) {
    if (s.category && !enabled.has(s.category)) continue;
    try {
      opportunities.push(...await s.collect(ctx));
    } catch (err) {
      errors.push({ source: s.eventType, err });
    }
  }
  return { opportunities, errors };
}

module.exports = { SOURCES, BY_EVENT_TYPE, collectAll };
