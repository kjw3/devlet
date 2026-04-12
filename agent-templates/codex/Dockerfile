# devlet/codex — Codex agent container
# TODO (Codex): flesh out bootstrap logic
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Codex CLI
RUN npm install -g @openai/codex

WORKDIR /workspace

COPY bootstrap.sh /devlet/bootstrap.sh
RUN chmod +x /devlet/bootstrap.sh

ENTRYPOINT ["/devlet/bootstrap.sh"]
