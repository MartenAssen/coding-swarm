#!/bin/bash
set -e

REPO_DIR="${REPO_DIR:-/data/repo}"
GITHUB_REPO="${GITHUB_REPO:-}"
LOCK_FILE="/data/.repo-init.lock"

# Use a lock file so only one container clones/pulls at a time
(
  flock -w 120 9 || { echo "ERROR: Could not acquire repo lock after 120s"; exit 1; }

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
    echo "Repo already exists at $REPO_DIR, skipping clone."
  fi

) 9>"$LOCK_FILE"

# Create worktrees directory
mkdir -p /data/worktrees

exec node /app/dist/index.js
