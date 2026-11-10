// routes/joinPageRoutes.js — the public invitation landing page and its share image.
//
//   GET /join/:token             server-rendered HTML (Open Graph / Twitter in the HTML)
//   GET /join/:token/image.jpg   1200×630 JPEG invitation card
//
// Served by the API (api.humrah.in). https://humrah.in/join/* reaches it through a
// Vercel rewrite on the website, the same way /post/:postId already does.
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const invites = require('../services/invitations/invitationService');
const { isWellFormed } = require('../services/invitations/inviteToken');
const { renderLandingPage } = require('../services/invitations/inviteLandingPage');
const { renderInviteCard, cachedCard } = require('../services/invitations/inviteImage');
const { summaryLine, shouldAutoOpen, joinHref } = require('../services/invitations/inviteLandingPage');
const { DEFAULT_IMAGE_URL } = require('../utils/roomTopicConfig');

const router = express.Router();

const clientIp = (req) => {
  const fwd = req.headers['x-forwarded-for'];
  const raw = typeof fwd === 'string' && fwd.length > 0 ? fwd.split(',')[0].trim() : (req.ip || 'unknown');
  return raw.replace(/^::ffff:/, '');
};
const ipLimiter = (max) => rateLimit({
  windowMs: 5 * 60 * 1000, max, keyGenerator: clientIp,
  standardHeaders: true, legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  handler: (_req, res) => res.status(429).type('text/plain').send('Too many requests. Please try again shortly.'),
});

const pageLimiter = ipLimiter(Number(process.env.INVITE_PAGE_PER_5MIN || 240));
const imageLimiter = ipLimiter(Number(process.env.INVITE_IMAGE_PER_5MIN || 240));

const isAndroidUa = (req) => /android/i.test(String(req.headers['user-agent'] || ''));

router.get('/join/:token', pageLimiter, async (req, res) => {
  const token = req.params.token;
  const linkUrl = invites.linkFor(isWellFormed(token) ? token : '');
  let preview = { success: false, state: 'INVITE_INVALID', message: 'This invite link is not valid.' };
  let status = 404;
  try {
    if (isWellFormed(token)) {
      const r = await invites.getPreview(token, null);
      preview = r.body;
      status = r.status;
    }
  } catch (err) {
    console.error('[INVITES] landing page:', err.message);
    preview = { success: false, state: 'ERROR', message: 'Something went wrong. Please try again.' };
    status = 503;
  }
  // A person tapping the link in an Android browser goes straight to the app (or to the
  // Play Store when it is not installed): a redirect inside the navigation they started,
  // which Chrome allows for intent:// URLs. Preview bots, WebViews and other platforms get
  // the page. Only for links that still lead somewhere; dead links show their explanation.
  if (preview && preview.success && shouldAutoOpen(req.headers['user-agent'])) {
    return res.status(302)
      .set('Location', joinHref(token, true))
      .set('Cache-Control', 'no-store')
      .set('Vary', 'User-Agent')
      .end();
  }
  const html = renderLandingPage({
    preview,
    token,
    linkUrl,
    imageUrl: isWellFormed(token) ? invites.imageFor(token) : DEFAULT_IMAGE_URL,
    fallbackImageUrl: DEFAULT_IMAGE_URL,
    isAndroid: isAndroidUa(req),
  });
  res.status(status)
    // The answer depends on the User-Agent (redirect vs page), and a shared cache such as the
    // website's edge may ignore Vary, so nothing between here and the client may store it.
    .set('Cache-Control', 'no-store')
    .set('Vary', 'User-Agent')
    .type('html')
    .send(html);
});

async function buildCard(token) {
  const { body } = await invites.getPreview(token, null);
  if (!body.success) return { card: null, cover: null };
  const g = body.group;
  const card = {
    type: body.type,
    title: g.title,
    subtitle: summaryLine(body) || body.typeLabel,
    inviterName: body.inviter.firstName,
    coverUrl: g.imageUrl || DEFAULT_IMAGE_URL,
    avatarUrl: body.inviter.profilePhoto,
  };
  return { card, cover: card.coverUrl };
}

router.get('/join/:token/image.jpg', imageLimiter, async (req, res) => {
  const token = req.params.token;
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (!isWellFormed(token)) return res.redirect(302, DEFAULT_IMAGE_URL);
  try {
    let cover = null;
    const buf = await cachedCard(`invite:${token}`, async () => {
      const built = await buildCard(token);
      cover = built.cover;
      return built.card ? renderInviteCard(built.card) : null;
    });
    if (!buf) return res.redirect(302, cover || DEFAULT_IMAGE_URL);
    return res.status(200)
      .set('Content-Type', 'image/jpeg')
      .set('Content-Length', String(buf.length))
      .set('Cache-Control', 'public, max-age=600, s-maxage=600')
      .send(buf);
  } catch (err) {
    console.error('[INVITES] invite image:', err.message);
    return res.redirect(302, DEFAULT_IMAGE_URL);
  }
});

module.exports = router;
