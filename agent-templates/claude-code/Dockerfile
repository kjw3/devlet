# devlet/claude-code — Claude Code agent container
# TODO (Codex): flesh out bootstrap logic
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI (pinned — see docs/dependency-pins.md)
RUN npm install -g @anthropic-ai/claude-code@2.1.302

WORKDIR /workspace

# Bootstrap script (injected by devlet server at launch)
COPY bootstrap.sh /devlet/bootstrap.sh
RUN chmod +x /devlet/bootstrap.sh

ENTRYPOINT ["/devlet/bootstrap.sh"]
