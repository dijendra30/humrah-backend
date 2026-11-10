// services/invitations/inviteImage.js — the 1200×630 invitation card (Open Graph image).
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ blurred, darkened cover                       ┌────────┐ │
//   │ (avatar) Invited by Riya                      │ cover  │ │
//   │ Weekend Badminton game                        │ image  │ │
//   │ Sports Plan · Sat 9:00 AM · Bengaluru         │        │ │
//   │ humrah                    Join on Humrah      └────────┘ │
//   └──────────────────────────────────────────────────────────┘
//
// Built with sharp (already a dependency). Text uses the bundled Plus Jakarta Sans
// (SIL OFL 1.1, the app's own brand font) through `text.fontfile`, because the
// production image (node:22-alpine) has no system fonts. If text rendering fails
// the card is still produced without it, and if everything fails the caller gets
// null and falls back to the plain cover image.
//
// Remote images: https only, from an allow-list of hosts the backend itself writes
// (Cloudinary, TMDB, the R2 artwork bucket), 4 s timeout, 6 MB cap — the URL is
// never taken from the request.
'use strict';

const path = require('path');
const sharp = require('sharp');

const W = 1200;
const H = 630;
const FONT_FILE = path.join(__dirname, '..', '..', 'assets', 'fonts', 'PlusJakartaSans.ttf');
const FONT = 'Plus Jakarta Sans';
const FETCH_TIMEOUT_MS = 4000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

const ALLOWED_HOSTS = [
  /^res\.cloudinary\.com$/i,
  /^image\.tmdb\.org$/i,
  /^pub-[a-z0-9]+\.r2\.dev$/i,
  /^(www\.)?humrah\.in$/i,
  /^api\.humrah\.in$/i,
];

function isAllowedImageUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch (_) {
    return false;
  }
}

async function fetchImage(url) {
  if (!url || !isAllowedImageUrl(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_IMAGE_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    // Must actually decode as an image.
    await sharp(buf, { limitInputPixels: 40e6 }).metadata();
    return buf;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Escapes text for Pango markup / SVG. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function renderText(markup, { size, width, weight, color }) {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${color}" weight="${weight}">${markup}</span>`,
      font: `${FONT} ${size}`,
      fontfile: FONT_FILE,
      width,
      rgba: true,
      dpi: 72,
      wrap: 'word',
    },
  }).png().toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

/**
 * Text as a transparent PNG. With maxHeight and plainText, words are dropped from the
 * end (with an ellipsis) until the block fits, so a line is never cut in half.
 */
async function textImage(markup, { size, width, weight = 'normal', color = '#ffffff', maxHeight, plainText }) {
  let out = await renderText(markup, { size, width, weight, color });
  if (!maxHeight || out.height <= maxHeight || !plainText) return out;
  const words = String(plainText).split(/\s+/).filter(Boolean);
  while (words.length > 1 && out.height > maxHeight) {
    words.pop();
    out = await renderText(`${esc(words.join(' ').replace(/[\s,.;:–-]+$/, ''))}…`, { size, width, weight, color });
  }
  return out;
}

const gradientSvg = (hasCover) => Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0b0f19" stop-opacity="${hasCover ? 0.92 : 1}"/>
      <stop offset="0.62" stop-color="#111827" stop-opacity="${hasCover ? 0.78 : 1}"/>
      <stop offset="1" stop-color="#2e1065" stop-opacity="${hasCover ? 0.55 : 1}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect x="0" y="${H - 6}" width="${W}" height="6" fill="#a78bfa"/>
</svg>`);

const roundedMask = (w, h, r) => Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></svg>`);
const circleMask = (d) => Buffer.from(`<svg width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}"/></svg>`);

async function roundedImage(buf, w, h, r) {
  return sharp(buf).resize(w, h, { fit: 'cover', position: 'attention' })
    .composite([{ input: roundedMask(w, h, r), blend: 'dest-in' }])
    .png().toBuffer();
}

function initialAvatar(name, d) {
  const letter = esc((String(name || 'H').trim()[0] || 'H').toUpperCase());
  return Buffer.from(`<svg width="${d}" height="${d}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#7c3aed"/>
    <text x="50%" y="50%" dy=".35em" text-anchor="middle" font-size="${d * 0.45}" fill="#ffffff" font-family="sans-serif">${letter}</text>
  </svg>`);
}

/**
 * @param {object} card
 *   type: 'ROOM'|'SPORTS'|'MOVIE', title, subtitle, inviterName, coverUrl, avatarUrl
 * @returns {Promise<Buffer|null>} JPEG
 */
async function renderInviteCard(card) {
  try {
    const [cover, avatar] = await Promise.all([fetchImage(card.coverUrl), fetchImage(card.avatarUrl)]);
    const layers = [];

    let base;
    if (cover) {
      base = sharp(cover).resize(W, H, { fit: 'cover', position: 'attention' }).blur(24).modulate({ brightness: 0.7 });
    } else {
      base = sharp({ create: { width: W, height: H, channels: 3, background: '#111827' } });
    }
    layers.push({ input: gradientSvg(!!cover), left: 0, top: 0 });

    // Cover card on the right: portrait poster for movies, square artwork otherwise.
    const portrait = card.type === 'MOVIE';
    const cw = portrait ? 300 : 380;
    const ch = portrait ? 450 : 380;
    const cardLeft = W - cw - 64;
    if (cover) {
      layers.push({ input: await roundedImage(cover, cw, ch, 28), left: cardLeft, top: Math.round((H - ch) / 2) });
    }
    const textWidth = (cover ? cardLeft : W) - 72 - 48;

    // Inviter: avatar + "Invited by X".
    const AV = 88;
    const avatarPng = avatar
      ? await sharp(avatar).resize(AV, AV, { fit: 'cover' }).composite([{ input: circleMask(AV), blend: 'dest-in' }]).png().toBuffer()
      : await sharp(initialAvatar(card.inviterName, AV)).png().toBuffer();
    layers.push({ input: avatarPng, left: 72, top: 72 });

    try {
      const inviter = await textImage(`Invited by <b>${esc(card.inviterName)}</b>`, { size: 30, width: textWidth - AV - 24, color: '#e9d5ff' });
      layers.push({ input: inviter.input, left: 72 + AV + 20, top: 72 + Math.max(0, Math.round((AV - inviter.height) / 2)) });

      const title = await textImage(esc(card.title), { size: 58, width: textWidth, weight: 'bold', maxHeight: 160, plainText: card.title });
      layers.push({ input: title.input, left: 72, top: 200 });

      if (card.subtitle) {
        const sub = await textImage(esc(card.subtitle), { size: 28, width: textWidth, color: '#cbd5e1', maxHeight: 80, plainText: card.subtitle });
        layers.push({ input: sub.input, left: 72, top: 200 + title.height + 22 });
      }

      const brand = await textImage('humrah', { size: 40, weight: 'bold', width: 300, color: '#c4b5fd' });
      layers.push({ input: brand.input, left: 72, top: H - 72 - brand.height });
      const cta = await textImage('Join on Humrah  →', { size: 28, weight: 'bold', width: 360, color: '#0b0f19' });
      const pillW = cta.width + 48;
      const pillH = cta.height + 28;
      const pill = Buffer.from(`<svg width="${pillW}" height="${pillH}"><rect width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="#a78bfa"/></svg>`);
      const pillLeft = 72 + brand.width + 36;
      const pillTop = H - 72 - pillH + 6;
      layers.push({ input: pill, left: pillLeft, top: pillTop });
      layers.push({ input: cta.input, left: pillLeft + 24, top: pillTop + 14 });
    } catch (err) {
      console.warn('[INVITES] invite card text unavailable:', err.message);
    }

    return await base.composite(layers).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } catch (err) {
    console.warn('[INVITES] invite card render failed:', err.message);
    return null;
  }
}

// ── tiny TTL cache (per process) ──────────────────────────────────────────────
const cache = new Map();
const inflight = new Map();

async function cachedCard(key, build) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.buf;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const buf = await build();
      if (buf) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, { buf, at: Date.now() });
      }
      return buf;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

module.exports = { renderInviteCard, cachedCard, isAllowedImageUrl, W, H, _clearCache: () => cache.clear() };
