#!/bin/bash
set -e

LOCK_FILE="/data/.repo-init.lock"

# Use a lock file so only one container clones/pulls at a time
(
  flock -w 120 9 || { echo "ERROR: Could not acquire repo lock after 120s"; exit 1; }

  if [ -n "$GITHUB_REPOS" ]; then
    # Multi-repo mode: clone each repo from comma-separated "label:owner/repo" pairs
    echo "Multi-repo mode: $GITHUB_REPOS"
    mkdir -p /data/repos

    IFS=',' read -ra PAIRS <<< "$GITHUB_REPOS"
    for pair in "${PAIRS[@]}"; do
      pair=$(echo "$pair" | xargs)  # trim whitespace
      label="${pair%%:*}"
      repo="${pair#*:}"
      label=$(echo "$label" | xargs)
      repo=$(echo "$repo" | xargs)

      if [ -z "$label" ] || [ -z "$repo" ]; then
        echo "WARNING: Skipping invalid GITHUB_REPOS entry: '$pair'"
        continue
      fi

      REPO_DIR="/data/repos/$label"
      if [ ! -d "$REPO_DIR/.git" ]; then
        echo "Cloning $repo into $REPO_DIR..."
        git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${repo}.git" "$REPO_DIR"
        cd "$REPO_DIR"
        git config user.name "agent"
        git config user.email "agent@noreply"
        cd /
      else
        echo "Repo $label already exists at $REPO_DIR, skipping clone."
      fi
    done
  else
    # Legacy single-repo mode
    REPO_DIR="${REPO_DIR:-/data/repo}"
    GITHUB_REPO="${GITHUB_REPO:-}"

    if [ ! -d "$REPO_DIR/.git" ]; then
      if [ -z "$GITHUB_REPO" ]; then
        echo "ERROR: Neither GITHUB_REPOS nor GITHUB_REPO is set"
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
  fi

) 9>"$LOCK_FILE"

# Create worktrees directory
mkdir -p /data/worktrees

exec node /app/dist/index.js
