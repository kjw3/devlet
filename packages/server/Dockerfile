ARG NODE_IMAGE=node:22.22.2-slim
FROM ${NODE_IMAGE}

ARG PNPM_VERSION=10.33.0
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG VERSION=0.1.0
ARG REPOSITORY_URL=https://github.com/kjw3/devlet

RUN npm install -g pnpm@${PNPM_VERSION}
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/server/ ./packages/server/

WORKDIR /app/packages/server

EXPOSE 3001

LABEL org.opencontainers.image.title="devlet-server"
LABEL org.opencontainers.image.description="Devlet API server"
LABEL org.opencontainers.image.source="${REPOSITORY_URL}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.version="${VERSION}"

CMD ["node", "--import", "tsx/esm", "src/index.ts"]
