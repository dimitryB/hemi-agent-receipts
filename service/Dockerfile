# syntax=docker/dockerfile:1
# hemi-agent-receipts service. Build context: the repository root (npm workspaces):
#   docker build -f service/Dockerfile -t hemi-agent-receipts-service .
# or `docker compose build` from the root. service/Dockerfile.dockerignore keeps the context
# to package manifests, sdk/ and service/ sources (no node_modules, no .env).

FROM node:22-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# Every workspace manifest, so the lockfile resolves; only sdk + service get installed.
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY contracts/package.json contracts/
COPY sdk/package.json sdk/
COPY cli/package.json cli/
COPY service/package.json service/
COPY e2e/package.json e2e/
RUN npm ci --workspace sdk --workspace service --include-workspace-root
COPY sdk/ sdk/
COPY service/ service/
RUN npm run build -w sdk && npm run build -w service

FROM node:22-slim AS prod-deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json .npmrc ./
COPY contracts/package.json contracts/
COPY sdk/package.json sdk/
COPY cli/package.json cli/
COPY service/package.json service/
COPY e2e/package.json e2e/
RUN npm ci --workspace sdk --workspace service --omit=dev

FROM node:22-slim
ENV NODE_ENV=production DB_PATH=/data/receipts.sqlite PORT=8787 HOST=0.0.0.0
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/sdk/package.json sdk/
COPY --from=build /app/sdk/dist sdk/dist
COPY --from=build /app/service/package.json service/
COPY --from=build /app/service/dist service/dist
COPY --from=build /app/service/migrations service/migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
# Reads `ok` from /health, which stays false while the RPC is unreachable (HTTP stays 200).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>r.json()).then(b=>process.exit(b&&b.ok===true?0:1),()=>process.exit(1))"]
# node:sqlite is stable enough for us but still flagged experimental on Node 22.
CMD ["node", "--disable-warning=ExperimentalWarning", "service/dist/index.js"]
