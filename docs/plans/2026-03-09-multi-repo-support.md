# Multi-Repo Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support multiple GitHub repos per Linear workspace, routing issues to the correct repo via labels.

**Architecture:** New `src/repos.ts` module parses `GITHUB_REPOS` env var (comma-separated `label:owner/repo` pairs) into a map. The poller resolves each issue's repo from its labels, then passes repo context through to the agent. Entrypoint clones all repos at startup. Full backwards compatibility when only `GITHUB_REPO` is set.

**Tech Stack:** TypeScript, bash (entrypoint), Docker Compose

---

### Task 1: Create `src/repos.ts` module

**Files:**
- Create: `src/repos.ts`

**Step 1: Create the repos module**

```typescript
/**
 * Multi-repo support. Parses GITHUB_REPOS env var into a map of label → repo config.
 * Format: "label1:owner/repo1,label2:owner/repo2"
 * Falls back to GITHUB_REPO + REPO_DIR for single-repo deployments.
 */

export interface RepoConfig {
  label: string;
  repo: string;      // "owner/repo"
  repoDir: string;   // "/data/repos/<label>"
}

const REPOS_BASE_DIR = "/data/repos";

function parseRepoMap(): Map<string, RepoConfig> {
  const raw = process.env.GITHUB_REPOS;
  if (!raw) return new Map();

  const map = new Map<string, RepoConfig>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      console.warn(`[repos] Skipping invalid GITHUB_REPOS entry (no colon): "${trimmed}"`);
      continue;
    }
    const label = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const repo = trimmed.slice(colonIdx + 1).trim();
    if (!label || !repo) {
      console.warn(`[repos] Skipping invalid GITHUB_REPOS entry: "${trimmed}"`);
      continue;
    }
    map.set(label, { label, repo, repoDir: `${REPOS_BASE_DIR}/${label}` });
  }
  return map;
}

const repoMap = parseRepoMap();

/**
 * Get all configured repos (for startup cloning).
 * Falls back to single GITHUB_REPO if GITHUB_REPOS is not set.
 */
export function getAllRepos(): RepoConfig[] {
  if (repoMap.size > 0) return [...repoMap.values()];

  // Legacy single-repo fallback
  const repo = process.env.GITHUB_REPO;
  if (!repo) return [];
  return [{ label: "_default", repo, repoDir: process.env.REPO_DIR || "/data/repo" }];
}

/**
 * Match an issue's labels against the repo map.
 * Returns the first matching repo config, or null if no match.
 */
export function getRepoForIssue(labels: string[]): RepoConfig | null {
  if (repoMap.size === 0) {
    // Legacy mode: return single repo if set
    const repo = process.env.GITHUB_REPO;
    if (!repo) return null;
    return { label: "_default", repo, repoDir: process.env.REPO_DIR || "/data/repo" };
  }

  for (const lbl of labels) {
    const config = repoMap.get(lbl.toLowerCase());
    if (config) return config;
  }
  return null;
}

/**
 * Get the list of known repo labels (for PM to list in comments).
 */
export function getRepoLabels(): string[] {
  return [...repoMap.keys()];
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/repos.ts
git commit -m "feat: add repos module for multi-repo label mapping"
```

---

### Task 2: Update entrypoint to clone multiple repos

**Files:**
- Modify: `entrypoint.sh`

**Step 1: Rewrite entrypoint.sh to handle both single and multi-repo**

```bash
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
```

**Step 2: Commit**

```bash
git add entrypoint.sh
git commit -m "feat: entrypoint clones multiple repos from GITHUB_REPOS"
```

---

### Task 3: Update poller to resolve repo per issue

**Files:**
- Modify: `src/poller.ts`

**Step 1: Import repos module and add repo resolution logic**

Add import at top of `src/poller.ts`:
```typescript
import { getRepoForIssue, getRepoLabels } from "./repos.js";
```

Add import for `STATUS` (needed for WAITING state):
```typescript
import { STATUS } from "./statuses.js";
```

Add import for `linearAddComment` tool helper — actually, we need the Linear SDK directly for adding comments. The existing code already imports `LinearClient` dynamically. We'll use `moveIssue` which is already imported.

**Step 2: Update the `poll` function**

In the `poll` function, after the `activeIssues.has(issue.id)` check and the skipQA check, add repo resolution before processing:

Replace the section from `console.log(\`[\${role.displayName}] Picking up...` through the `processIssue` call with:

```typescript
      // Resolve which repo this issue targets
      const repoConfig = getRepoForIssue(issue.labels);
      if (!repoConfig) {
        if (role.name === "pm") {
          // PM: ask which repo and move to waiting
          console.log(
            `[${role.displayName}] No repo label found on ${issue.identifier}, asking for clarification`,
          );
          try {
            const { LinearClient } = await import("@linear/sdk");
            const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });
            const knownLabels = getRepoLabels();
            await client.createComment({
              issueId: issue.id,
              body: `This ticket is missing a repo label. Please add one of: ${knownLabels.map((l) => `\`${l}\``).join(", ")}`,
            });
            await moveIssue(issue.id, STATUS.WAITING);
          } catch (err) {
            console.warn(`[${role.displayName}] Failed to comment/move ${issue.identifier}:`, err);
          }
        } else {
          console.warn(
            `[${role.displayName}] Skipping ${issue.identifier} — no repo label found`,
          );
        }
        continue;
      }

      console.log(
        `[${role.displayName}] Picking up ${issue.identifier}: ${issue.title} (repo: ${repoConfig.label}, priority: ${issue.priority}, state: ${issue.stateName})`,
      );
```

**Step 3: Pass repoConfig to processIssue**

Update the `processIssue` call:
```typescript
      processIssue(role, issue, repoConfig).finally(() => {
```

Update `processIssue` signature:
```typescript
async function processIssue(
  role: RoleConfig,
  issue: { id: string; identifier: string; title: string; stateName: string; labels: string[]; priority: number },
  repoConfig: { label: string; repo: string; repoDir: string },
) {
```

**Step 4: Update processIssue to use repoConfig**

Change the repo sync section to use `repoConfig.repoDir`:
```typescript
    const repoDir = repoConfig.repoDir;
    try {
      console.log(`[${role.displayName}] Syncing repo ${repoConfig.label} before starting ${issue.identifier}`);
      execSync("git fetch origin && git pull --ff-only", {
```

Update the `invokeAgent` call to pass repoConfig:
```typescript
    const result = await invokeAgent(prompt, role, repoConfig);
```

**Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: Errors in `agent.ts` (expected — we update that next)

**Step 6: Commit**

```bash
git add src/poller.ts
git commit -m "feat: poller resolves repo per issue from labels"
```

---

### Task 4: Update agent to accept repo context

**Files:**
- Modify: `src/agent.ts`

**Step 1: Update invokeAgent signature and usage**

Add `repoContext` parameter:
```typescript
export async function invokeAgent(
  prompt: string,
  role: RoleConfig,
  repoContext: { repoDir: string; repo: string },
): Promise<AgentResult> {
```

Update `cwd` in the query options:
```typescript
          cwd: repoContext.repoDir,
```

Set `GITHUB_REPO` in the environment so tools pick up the correct repo. Add env override in the query options — since `query` doesn't support env overrides directly, set it on `process.env` before calling and restore after. Actually, since agents run concurrently, we should set it in the prompt or find another way.

**Better approach:** Set `process.env.GITHUB_REPO` to `repoContext.repo` before calling `query`. Since `MAX_CONCURRENT` is typically 1 per container, this is safe. But to be extra safe, wrap it:

```typescript
      // Set GITHUB_REPO for this agent session (tools read it from process.env)
      const prevRepo = process.env.GITHUB_REPO;
      const prevRepoDir = process.env.REPO_DIR;
      process.env.GITHUB_REPO = repoContext.repo;
      process.env.REPO_DIR = repoContext.repoDir;

      const session = query({
        prompt,
        options: {
          model: role.model,
          cwd: repoContext.repoDir,
          // ... rest unchanged
```

After the session completes (in the finally block or after the for-await loop):
```typescript
      // Restore env
      if (prevRepo !== undefined) process.env.GITHUB_REPO = prevRepo;
      else delete process.env.GITHUB_REPO;
      if (prevRepoDir !== undefined) process.env.REPO_DIR = prevRepoDir;
      else delete process.env.REPO_DIR;
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "feat: agent receives repo context, sets cwd and GITHUB_REPO per issue"
```

---

### Task 5: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Add GITHUB_REPOS env var to all services**

Add to each service's environment section (pm, engineer, tester):
```yaml
      GITHUB_REPOS: ${GITHUB_REPOS:-}
```

Keep the existing `GITHUB_REPO` line for backwards compatibility.

**Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: pass GITHUB_REPOS env var to all Docker services"
```

---

### Task 6: Update PM system prompt for repo label check

**Files:**
- Modify: `src/roles/pm.ts`

**Step 1: Add repo label instruction to PM system prompt**

In the system prompt, add a new step after step 1 (Read the ticket) and before step 2 (Clarify if needed):

Add to the beginning of the workflow section:
```
2. **Check repo label** — The ticket MUST have a repo label (one of the configured repository labels). If missing, post a comment asking which repo this belongs to, move to "${STATUS.WAITING}", and stop.
```

Renumber remaining steps 2→3, 3→4, etc.

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/roles/pm.ts
git commit -m "feat: PM checks for repo label, asks if missing"
```

---

### Task 7: Update .env and .env.example

**Files:**
- Modify: `.env`
- Modify: `.env.example`

**Step 1: Add GITHUB_REPOS to .env**

Add after the GITHUB_REPO line:
```env
# Multi-repo map (label:owner/repo, comma-separated)
GITHUB_REPOS=paddock-app:Pontifexx-Tech/paddock-app,asset-dm:Pontifexx-Tech/asset-data-manager
```

**Step 2: Add GITHUB_REPOS to .env.example**

Add after the GITHUB_REPO line:
```env
# Multi-repo support (optional — comma-separated label:owner/repo pairs)
# When set, issues need a label matching one of these keys to route to the correct repo
# GITHUB_REPOS=app:owner/app-repo,api:owner/api-repo
```

**Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: add GITHUB_REPOS to .env.example"
```

Note: Do NOT commit `.env` — it contains secrets.

---

### Task 8: Final type-check and smoke test

**Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Build**

Run: `npm run build`
Expected: Clean build, `dist/` output

**Step 3: Commit any remaining changes**

```bash
git add -A
git commit -m "feat: multi-repo support complete"
```
