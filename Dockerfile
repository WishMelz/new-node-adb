FROM node:22.23.4-slim

LABEL org.opencontainers.image.title="ADB Desk" \
    org.opencontainers.image.description="Self-hosted Android web control console powered by ADB and scrcpy"

ENV NODE_ENV=production \
    DOCKER_PORT=23120 \
    DATA_DIR=/app/.data \
    ADB_PATH=/usr/bin/adb \
    HOME=/app/.data
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends adb ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --omit=dev --workspace=@adb/api --include-workspace-root=false --no-audit --no-fund \
    && npm cache clean --force

COPY apps/api/dist ./apps/api/dist
COPY apps/web/dist ./apps/web/dist
COPY vendor ./vendor

RUN install -d -o node -g node -m 0700 /app/.data

USER node
EXPOSE 23120
CMD ["node", "apps/api/dist/main.js"]