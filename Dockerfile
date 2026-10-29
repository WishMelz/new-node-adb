FROM node:22.23.4-slim

ENV NODE_ENV=production
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

USER node
EXPOSE 23110
CMD ["node", "apps/api/dist/main.js"]