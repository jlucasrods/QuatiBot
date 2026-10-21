FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN npm install -g pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs/package.json ./apps/docs/package.json
COPY scripts/install-git-hooks.mjs ./scripts/install-git-hooks.mjs
RUN pnpm install --frozen-lockfile
COPY . .
RUN node scripts/prepare-duckdb.mjs \
    && pnpm build:server && pnpm exec vite build \
    && chmod -R go-w dist dist-server dist-native/duckdb

FROM node:24-bookworm-slim AS server
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client ffmpeg \
       libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
       libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 \
       libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
       libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
       libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
       libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
       libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --home-dir /data --shell /bin/bash quati
ARG OPENCODE_VERSION=2.0.31
RUN HOME=/tmp/quati-install npm install -g --cache /tmp/npm-cache @opencode/cli@${OPENCODE_VERSION} \
    && HOME=/tmp/quati-install opencode --version | grep -E '^opencode v?2\.' \
    && rm -rf /tmp/quati-install /tmp/npm-cache /tmp/node-compile-cache
ARG AGENT_BROWSER_VERSION=0.39.1
ARG CHROME_CACHE_TAG=""
RUN echo "Chrome cache: ${CHROME_CACHE_TAG:-Stable}" \
    && npm install -g --cache /tmp/npm-cache agent-browser@${AGENT_BROWSER_VERSION} \
    && HOME=/opt/quatibot-browser agent-browser install \
    && ln -s /opt/quatibot-browser/.agent-browser/browsers/chrome-*/chrome /opt/quatibot-browser/chrome \
    && agent-browser --version \
    && rm -rf /tmp/npm-cache /tmp/node-compile-cache
ENV HOME=/data \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/quatibot-browser/chrome \
    QUATI_DUCKDB_DIR=/app/duckdb \
    QUATI_DATA_DIR=/data/.quatibot \
    QUATI_STATIC_DIR=/app/dist \
    QUATI_PORT=8799 \
    QUATI_WEBHOOK_PORT=8800 \
    NODE_ENV=production
WORKDIR /app
COPY LICENSE NOTICE LICENSING.md ./
COPY third_party/ ./third_party/
COPY --from=build /src/dist-native/duckdb/linux-x64 ./duckdb
COPY --from=build /src/dist-server ./dist-server
COPY --from=build /src/dist ./dist
VOLUME ["/data"]
USER quati
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -sf http://127.0.0.1:8799/api/health | grep -q quatibot || exit 1
CMD ["node", "dist-server/server-launcher.js"]
