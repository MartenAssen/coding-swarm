FROM node:22-slim AS builder

WORKDIR /app
COPY package.json ./
RUN npm install --legacy-peer-deps
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  curl \
  ca-certificates \
  jq \
  openssh-client \
  && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (needed by the agent SDK for dev-agent subagent)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY --from=builder /app/dist/ dist/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh \
  && mkdir -p /data/repo /data/worktrees \
  && chown -R node:node /app /data

# Run as non-root 'node' user (UID 1000, already in base image)
# Required: Claude Code CLI refuses --dangerously-skip-permissions as root
USER node

ENTRYPOINT ["/app/entrypoint.sh"]
