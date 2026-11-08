// services/engagement/sources/catalogSource.js
// INFORMATIVE / SOCIAL / FUNNY / SEASONAL — approved catalog content (catalog.js).
// Only categories an operator enabled are considered (the selection engine filters too).
// Requirements look only at the user's OWN account.
'use strict';

const RoomMember = require('../../../models/RoomMember');
const Question = require('../../../models/Question');
const { activeEntries } = require('../catalog');

const DAY = 24 * 3600 * 1000;

async function requirementHolds(requires, userId) {
  if (!requires) return true;
  if (requires === 'NEVER_JOINED_ROOM') return !(await RoomMember.exists({ userId }));
  if (requires === 'NEVER_ASKED_QUESTION') return !(await Question.exists({ askerId: userId }));
  return false;
}

async function collect(ctx) {
  const enabled = new Set(ctx.cfg.enabledCategories);
  const out = [];
  for (const entry of activeEntries(ctx.now)) {
    if (!enabled.has(entry.category)) continue;
    if (!(await requirementHolds(entry.requires, ctx.userId))) continue;
    out.push({
      category: entry.category,
      eventType: 'CATALOG',
      eventRef: { kind: 'Catalog', id: entry.key },
      eventKey: `CATALOG:${entry.key}`,
      templateKey: entry.templateKey,
      vars: {},
      // An entry backed by a fact about the user's own account is more relevant than
      // an unconditional one.
      relevance: entry.requires ? 0.7 : 0.5,
      relevantUntil: entry.activeUntil ? new Date(entry.activeUntil) : new Date(ctx.now + 7 * DAY),
    });
  }
  return out;
}

async function revalidate(doc, user, now) {
  const entry = activeEntries(now).find(e => e.key === doc.eventRef.id);
  if (!entry) return { ok: false, reason: 'EVENT_NOT_ACTIVE' };
  if (!(await requirementHolds(entry.requires, user._id))) return { ok: false, reason: 'EVENT_REQUIREMENT_GONE' };
  return { ok: true };
}

module.exports = { category: null, eventType: 'CATALOG', collect, revalidate, _internal: { requirementHolds } };
