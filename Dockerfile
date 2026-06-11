# ── Stage 1: install dependencies ──────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy package files first (layer cache: only reinstalls if these change)
COPY package.json package-lock.json* ./

# Install production deps only
# sharp needs platform-specific binaries → --ignore-scripts skips postinstall
# but we need the correct binary, so we use npm ci with platform flags
RUN npm ci --omit=dev --prefer-offline 2>/dev/null || npm install --omit=dev

# ── Stage 2: production image ───────────────────────────────────────────────────
FROM node:22-alpine

# Non-root user for security
RUN addgroup -S humrah && adduser -S humrah -G humrah

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Remove dev files that shouldn't be in the image
RUN rm -rf .git .gitignore .env.example nodemon.json \
           *.md nixpacks.toml

# Switch to non-root
USER humrah

EXPOSE 10000

ENV NODE_ENV=production
ENV PORT=10000

# Healthcheck — Coolify will use this
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-10000}/api/health" || exit 1

CMD ["node", "server.js"]
