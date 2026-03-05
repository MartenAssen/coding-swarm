#!/bin/bash
set -e

REPO_DIR="${REPO_DIR:-/data/repo}"
GITHUB_REPO="${GITHUB_REPO:-}"

# Clone repo on first boot if it doesn't exist
if [ ! -d "$REPO_DIR/.git" ]; then
  if [ -z "$GITHUB_REPO" ]; then
    echo "ERROR: GITHUB_REPO not set and $REPO_DIR does not exist"
    exit 1
  fi
  echo "Cloning $GITHUB_REPO into $REPO_DIR..."
  git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git" "$REPO_DIR"
  cd "$REPO_DIR"
  git config user.name "agent"
  git config user.email "agent@noreply"
else
  echo "Repo already exists at $REPO_DIR, pulling latest..."
  cd "$REPO_DIR"
  git pull origin main || true
fi

# Create worktrees directory
mkdir -p /data/worktrees

exec node /app/dist/index.js
