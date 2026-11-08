// services/adminAuth/adminPermissions.js — which dashboard section every admin API belongs to.
//
// Access levels (all decided on the server, re-checked on every request):
//   owner  — email in ADMIN_ALLOWED_EMAILS and account role SUPER_ADMIN. Everything, including
//            OWNER-ONLY areas: admin access management, the audit/security logs, admin accounts,
//            branding, payouts.
//   admin  — email in ADMIN_ALLOWED_EMAILS with role SAFETY_ADMIN. Every section, never OWNER-ONLY.
//   member — added by an owner on the Admin Logs page (AdminMember). Only the sections the owner
//            ticked. Never OWNER-ONLY.
// A path that matches nothing below is treated as OWNER-ONLY (default deny for members).
'use strict';

const SECTIONS = Object.freeze({
  dashboard:      { label: 'Dashboard & analytics', prefixes: ['/api/admin/dashboard', '/api/admin-dashboard/dashboard', '/api/admin-analytics'] },
  users:          { label: 'Users', prefixes: ['/api/admin/users'] },
  moderation:     { label: 'Moderation', prefixes: ['/api/admin/moderation', '/api/moderation', '/api/admin/questions', '/api/admin/post-reports', '/api/reviews/admin'] },
  reports:        { label: 'Reports & safety', prefixes: ['/api/admin-dashboard/reports', '/api/safety/admin'] },
  support:        { label: 'Support (Founder Inbox)', prefixes: ['/api/founder/admin', '/api/founder/chats'] },
  verifications:  { label: 'Verifications', prefixes: ['/api/admin-dashboard/verifications', '/api/verification/admin', '/api/users/admin', '/api/admin-dashboard/companions'] },
  broadcasts:     { label: 'Broadcasts & profile completion', prefixes: ['/api/admin/broadcasts', '/api/admin-dashboard/broadcast', '/api/admin-dashboard/profile-completion'] },
  events:         { label: 'Events', prefixes: ['/api/official-events/admin', '/api/event-requests/admin', '/api/admin/places'] },
  content:        { label: 'Home banners & prompts', prefixes: ['/api/home-banners/admin', '/api/admin/prompts'] },
  launch_regions: { label: 'Launch regions', prefixes: ['/api/admin/launch-regions'] },
  app_updates:    { label: 'App updates', prefixes: ['/api/admin/app-updates'] },
});

const SECTION_KEYS = Object.freeze(Object.keys(SECTIONS));

/** Never grantable to members; owners only (some also need SUPER_ADMIN by their own route checks). */
const OWNER_ONLY_PREFIXES = Object.freeze([
  '/api/admin/admins', '/api/admin/audit-logs', '/api/admin/branding', '/api/admin/sports-discovery',
  '/api/payment/admin', '/api/auth/create-admin', '/api/admin/auth/members', '/api/admin/auth/security-events',
  '/api/admin-dashboard/restore-profile-completion', // bulk rewrite of every user's completion score
]);

const OWNER = 'owner';

function matches(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/');
}

/** Section key for an API path, or OWNER for owner-only / unmapped paths. */
function sectionForPath(rawPath) {
  const path = String(rawPath || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (OWNER_ONLY_PREFIXES.some(p => matches(path, p))) return OWNER;
  let best = null;
  let bestLen = -1;
  for (const key of SECTION_KEYS) {
    for (const p of SECTIONS[key].prefixes) {
      if (matches(path, p) && p.length > bestLen) { best = key; bestLen = p.length; }
    }
  }
  return best || OWNER;
}

/** Validates an owner-supplied section list: non-empty, known keys only, de-duplicated. */
function normaliseSections(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > SECTION_KEYS.length) return null;
  const out = [];
  for (const s of input) {
    if (typeof s !== 'string' || !SECTION_KEYS.includes(s)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const catalog = () => SECTION_KEYS.map(key => ({ key, label: SECTIONS[key].label }));

module.exports = { SECTIONS, SECTION_KEYS, OWNER_ONLY_PREFIXES, OWNER, sectionForPath, normaliseSections, catalog };
