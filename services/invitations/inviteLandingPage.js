// services/invitations/inviteLandingPage.js — server-rendered https://humrah.in/join/{token}.
//
// Everything a link-preview crawler needs (Open Graph + Twitter Card) is in the
// initial HTML; the page has no script at all. Every dynamic value is HTML-escaped.
// The og:image is absolute https (the API host). The <img> on the page itself uses
// a relative path so it is same-origin whether served by api.humrah.in directly or
// through the humrah.in rewrite (the API's CSP allows img-src 'self').
//
// "Join on Humrah": on Android an intent:// URL that opens the app's invitation
// screen if it is installed and falls back to the Play Store otherwise; elsewhere
// the Play Store page. Opening the app never joins anything — the app asks first.
'use strict';

const PACKAGE = 'in.humrah.app';
const PLAY_URL = `https://play.google.com/store/apps/details?id=${PACKAGE}`;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const TYPE_EMOJI = { ROOM: '💬', SPORTS: '🏅', MOVIE: '🎬' };
const TYPE_VERB = { ROOM: 'join a Humrah Room', SPORTS: 'join a game', MOVIE: 'join a Movie Hangout' };

function formatWhen(iso) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }).format(new Date(iso));
  } catch (_) {
    return null;
  }
}

/** The one-line "Sports Plan · Sat, 15 Nov, 9:00 am · Bengaluru" summary. */
function summaryLine(preview) {
  const g = preview.group || {};
  const parts = [preview.typeLabel, formatWhen(g.whenAt), g.placeLabel].filter(Boolean);
  return parts.join(' · ');
}

function metaFor(preview, { token, linkUrl, imageUrl }) {
  if (!preview || !preview.success || !preview.group) return null;
  const g = preview.group;
  const name = preview.inviter?.firstName || 'A friend';
  const emoji = TYPE_EMOJI[preview.type] || '✨';
  const title = `${emoji} ${name} invited you to ${g.title} on Humrah`;
  const counts = g.capacity ? `${g.memberCount}/${g.capacity} going` : (g.memberCount ? `${g.memberCount} members` : null);
  const lead = [summaryLine(preview), counts].filter(Boolean).join(' · ');
  const body = g.description ? `${g.description} ` : '';
  const description = `${lead}. ${body}Tap to ${TYPE_VERB[preview.type] || 'join'} with ${name}.`.replace(/\s+/g, ' ').trim();
  return { title, description, linkUrl, imageUrl, token };
}

function joinHref(token, isAndroid) {
  if (!isAndroid) return PLAY_URL;
  const fallback = encodeURIComponent(PLAY_URL);
  return `intent://join/${token}#Intent;scheme=humrah;package=${PACKAGE};S.browser_fallback_url=${fallback};end`;
}

const STYLE = `
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;
background:#0b0f19;color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.card{width:100%;max-width:440px;background:#111827;border:1px solid #1f2937;border-radius:20px;padding:20px;box-shadow:0 12px 32px rgba(0,0,0,.45)}
.brand{font-weight:800;font-size:22px;color:#c4b5fd;letter-spacing:.5px;margin:0 0 14px}
.hero{display:block;width:100%;aspect-ratio:1200/630;object-fit:cover;border-radius:14px;background:#1f2937}
.inviter{margin:16px 0 4px;color:#d8b4fe;font-size:15px}
h1{margin:0 0 8px;font-size:22px;line-height:1.3}
.meta{margin:0 0 10px;color:#9ca3af;font-size:14px;line-height:1.5}
.desc{margin:0 0 18px;color:#d1d5db;font-size:15px;line-height:1.5}
.btn{display:block;text-align:center;text-decoration:none;font-weight:700;font-size:16px;padding:14px;border-radius:12px;margin-top:10px}
.primary{background:#a78bfa;color:#0b0f19}.secondary{background:#1f2937;color:#e5e7eb;border:1px solid #374151}
.note{margin:14px 0 0;color:#6b7280;font-size:12px;text-align:center}
.state{margin:8px 0 14px;padding:10px 12px;border-radius:10px;background:#1f2937;color:#fcd34d;font-size:14px}`;

/**
 * @param {object} p
 *   preview  — invitationService.getPreview(token) body
 *   token, linkUrl, imageUrl (absolute og:image), fallbackImageUrl, isAndroid
 */
function renderLandingPage({ preview, token, linkUrl, imageUrl, fallbackImageUrl, isAndroid }) {
  const meta = metaFor(preview, { token, linkUrl, imageUrl });
  const usable = !!meta;

  const title = usable ? meta.title : 'This Humrah invite is no longer available';
  const description = usable
    ? meta.description
    : 'Ask the person who shared it for a new link, or find people to meet on Humrah.';
  const ogImage = usable ? imageUrl : fallbackImageUrl;
  const g = usable ? preview.group : null;
  const stateNote = !usable ? (preview && preview.message) || 'This invite link is not valid.'
    : preview.state === 'FULL' ? 'This group is full right now.'
      : preview.state === 'ENDED' ? 'This group has ended.' : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0b0f19">
<link rel="canonical" href="${esc(linkUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Humrah">
<meta property="og:locale" content="en_IN">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(linkUrl)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:secure_url" content="${esc(ogImage)}">
${usable ? `<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
` : ''}<meta property="og:image:alt" content="${esc(usable ? `${g.title} on Humrah` : 'Humrah')}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<meta name="twitter:image:alt" content="${esc(usable ? `${g.title} on Humrah` : 'Humrah')}">
<style>${STYLE}</style>
</head>
<body>
<main class="card">
<p class="brand">humrah</p>
${usable ? `<img class="hero" src="/join/${esc(token)}/image.jpg" alt="${esc(g.title)}" width="1200" height="630">
<p class="inviter">${esc(preview.inviter.firstName)} invited you</p>
<h1>${esc(g.title)}</h1>
<p class="meta">${esc([summaryLine(preview), g.capacity ? `${g.memberCount}/${g.capacity} going` : null].filter(Boolean).join(' · '))}</p>
${g.description ? `<p class="desc">${esc(g.description)}</p>` : ''}` : `<h1>${esc(title)}</h1>`}
${stateNote ? `<p class="state">${esc(stateNote)}</p>` : ''}
${usable ? `<a class="btn primary" href="${esc(joinHref(token, isAndroid))}">Join on Humrah</a>
<a class="btn secondary" href="${esc(PLAY_URL)}">Get the Humrah app</a>
<p class="note">Opening Humrah shows you the group first. You join only when you tap Join.</p>`
    : `<a class="btn primary" href="${esc(PLAY_URL)}">Get the Humrah app</a>`}
</main>
</body>
</html>`;
}

module.exports = { renderLandingPage, metaFor, joinHref, esc, PLAY_URL, formatWhen, summaryLine };
