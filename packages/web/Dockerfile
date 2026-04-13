ARG NODE_IMAGE=node:22.22.2-slim
ARG NGINX_IMAGE=nginx:1.28.3-alpine

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder

ARG PNPM_VERSION=10.33.0
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/

RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/web/ ./packages/web/

RUN pnpm --filter @devlet/web build

# ── Stage 2: Serve ────────────────────────────────────────────────────────────
FROM ${NGINX_IMAGE}

ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG VERSION=0.1.0
ARG REPOSITORY_URL=https://github.com/kjw3/devlet

COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html

EXPOSE 80

LABEL org.opencontainers.image.title="devlet-web"
LABEL org.opencontainers.image.description="Devlet web UI"
LABEL org.opencontainers.image.source="${REPOSITORY_URL}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.version="${VERSION}"
