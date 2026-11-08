// services/engagement/selection.js
// -----------------------------------------------------------------------------
// NOTIFICATION SELECTION ENGINE — pure and deterministic.
//
// For one user, from the opportunities the sources found:
//   1. drop categories that are not enabled, or that the user's settings exclude
//      (eligibility.categoryIssue: the category toggle; SPORTS needs verification);
//   2. drop events this user was already notified about (idempotency keys found);
//   3. drop events that will no longer be relevant when the notification can go out
//      (relevantUntil must be at least 15 minutes after scheduledAt);
//   4. score = categoryPriority × relevance × (0.8 if it repeats the last category)
//                                         × (1.1 if the user opened this category before);
//   5. order by score, then priority, then eventKey (so equal inputs → equal output);
//   6. take the first whose template renders cleanly.
// Returns the choice (or null) and a reason code for every rejected opportunity.
// -----------------------------------------------------------------------------
'use strict';

const { categoryIssue } = require('./eligibility');
const templates = require('./templates');

const RELEVANCE_MARGIN_MS = 15 * 60 * 1000;

function scoreOf(op, ctx, cfg) {
  const priority = cfg.priorities[op.category] || 0;
  const relevance = Math.max(0, Math.min(1, Number(op.relevance) || 0));
  let score = priority * relevance;
  if (ctx.history && ctx.history.lastCategory === op.category) score *= cfg.sameCategoryPenalty;
  if (ctx.history && ctx.history.openedCategories && ctx.history.openedCategories.has(op.category)) score *= cfg.openedCategoryBoost;
  return Math.round(score * 1000) / 1000;
}

/**
 * @param {object[]} opportunities
 * @param {object} ctx  personalisation context (user, history)
 * @param {object} opts { cfg, scheduledAt: Date, notifiedKeys: Set<eventKey> }
 */
function choose(opportunities, ctx, { cfg, scheduledAt, notifiedKeys }) {
  const enabled = new Set(cfg.enabledCategories);
  const rejected = [];
  const seen = new Set();
  const candidates = [];

  for (const op of opportunities || []) {
    if (!op || !op.eventKey || seen.has(op.eventKey)) { if (op && op.eventKey) rejected.push({ eventKey: op.eventKey, reason: 'DUPLICATE_OPPORTUNITY' }); continue; }
    seen.add(op.eventKey);
    if (!enabled.has(op.category)) { rejected.push({ eventKey: op.eventKey, reason: 'CATEGORY_NOT_ENABLED' }); continue; }
    const catIssue = categoryIssue(ctx.user, op.category);
    if (catIssue) { rejected.push({ eventKey: op.eventKey, reason: catIssue }); continue; }
    if (notifiedKeys && notifiedKeys.has(op.eventKey)) { rejected.push({ eventKey: op.eventKey, reason: 'ALREADY_NOTIFIED' }); continue; }
    if (op.relevantUntil && new Date(op.relevantUntil).getTime() < scheduledAt.getTime() + RELEVANCE_MARGIN_MS) {
      rejected.push({ eventKey: op.eventKey, reason: 'STALE_BY_SEND_TIME' }); continue;
    }
    candidates.push({ op, score: scoreOf(op, ctx, cfg), priority: cfg.priorities[op.category] || 0 });
  }

  candidates.sort((a, b) => (b.score - a.score) || (b.priority - a.priority) || (a.op.eventKey < b.op.eventKey ? -1 : a.op.eventKey > b.op.eventKey ? 1 : 0));

  for (const c of candidates) {
    const rendered = templates.render(c.op.templateKey, c.op.category, c.op.vars || {});
    if (!rendered.ok) { rejected.push({ eventKey: c.op.eventKey, reason: rendered.reason }); continue; }
    return { chosen: { ...c.op, score: c.score, priority: c.priority, rendered }, rejected };
  }
  return { chosen: null, rejected };
}

module.exports = { choose, scoreOf, RELEVANCE_MARGIN_MS };
