// middleware/requestLogger.js
// ─────────────────────────────────────────────────────────────────────────────
// Structured request/response logger.
// Attach BEFORE routes in server.js:  app.use(requestLogger);
//
// Output format:
//   [REQUEST] POST /api/auth/login — ip=::ffff:127.0.0.1
//   [RESPONSE] POST /api/auth/login — 200 (45ms)
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function requestLogger(req, res, next) {
  const start  = Date.now();
  const method = req.method;
  const url    = req.originalUrl || req.url;
  const ip     = req.ip || req.connection?.remoteAddress || 'unknown';

  // Skip health-check spam
  if (url === '/api/health') return next();

  console.log(`[REQUEST] ${method} ${url} — ip=${ip}`);

  // Log userId once auth middleware has run (available on res.finish)
  res.on('finish', () => {
    const ms     = Date.now() - start;
    const code   = res.statusCode;
    const userId = req.userId ? `userId=${req.userId}` : 'unauthenticated';

    if (code >= 500) {
      console.error(`[RESPONSE] ${method} ${url} — ${code} (${ms}ms) — ${userId}`);
    } else if (code >= 400) {
      console.warn(`[RESPONSE] ${method} ${url} — ${code} (${ms}ms) — ${userId}`);
    } else {
      console.log(`[RESPONSE] ${method} ${url} — ${code} (${ms}ms) — ${userId}`);
    }
  });

  next();
};
