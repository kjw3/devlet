# devlet/codex — Codex agent container
# TODO (Codex): flesh out bootstrap logic
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Codex CLI (pinned — see docs/dependency-pins.md)
RUN npm install -g @openai/codex@0.163.0

WORKDIR /workspace

COPY bootstrap.sh /devlet/bootstrap.sh
RUN chmod +x /devlet/bootstrap.sh

ENTRYPOINT ["/devlet/bootstrap.sh"]
