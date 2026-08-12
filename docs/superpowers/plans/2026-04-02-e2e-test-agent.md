# E2E Test Agent (Pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth agent (Pilot) to the pipeline that functionally tests PRs by starting the app and interacting with it via Playwright in the browser.

**Architecture:** Pilot slots in after Hawk (QA). It checks out the PR branch, starts the app, uses Playwright MCP to navigate and verify acceptance criteria, then approves or rejects. A separate Dockerfile adds Playwright + Chromium to the existing base image.

**Tech Stack:** TypeScript, Claude Agent SDK, Playwright MCP, Docker, Linear API, GitHub CLI

---

### Task 1: Add E2E_TESTING status

**Files:**
- Modify: `src/statuses.ts:1-12`

- [ ] **Step 1: Add the new status constant**

In `src/statuses.ts`, add `E2E_TESTING` to the STATUS object:

```typescript
export const STATUS = {
  BACKLOG: process.env.STATUS_BACKLOG || "Backlog",
  IN_PROGRESS: process.env.STATUS_IN_PROGRESS || "In Progress",
  IN_DEVELOPMENT: process.env.STATUS_IN_DEVELOPMENT || "In Development",
  IN_REVIEW: process.env.STATUS_IN_REVIEW || "In Review",
  E2E_TESTING: process.env.STATUS_E2E_TESTING || "E2E Testing",
  DONE: process.env.STATUS_DONE || "Done",
  WAITING: process.env.STATUS_WAITING || "Waiting",
} as const;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/statuses.ts
git commit -m "feat: add E2E_TESTING status for Pilot agent"
```

---

### Task 2: Update Hawk's doneState to E2E Testing

**Files:**
- Modify: `src/roles/qa.ts:15`

- [ ] **Step 1: Change Hawk's doneState default**

In `src/roles/qa.ts`, change line 15 from:

```typescript
const doneState = process.env.QA_DONE_STATE || "Ready for Review";
```

to:

```typescript
const doneState = process.env.QA_DONE_STATE || STATUS.E2E_TESTING;
```

Also update the `doneState` property on line 52 to match:

```typescript
doneState: process.env.QA_DONE_STATE || STATUS.E2E_TESTING,
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/roles/qa.ts
git commit -m "feat: route Hawk's done state to E2E Testing instead of Ready for Review"
```

---

### Task 3: Create the Pilot role configuration

**Files:**
- Create: `src/roles/e2e.ts`

- [ ] **Step 1: Create the e2e role file**

Create `src/roles/e2e.ts`:

```typescript
import type { RoleConfig } from "./index.js";
import {
  gitCreateWorktree,
  gitCleanupWorktree,
  ghPrReview,
} from "../tools/github.js";
import {
  linearGetIssue,
  linearUpdateIssueState,
  linearAddComment,
} from "../tools/linear.js";
import { STATUS } from "../statuses.js";
import { LABEL } from "../labels.js";

const doneState = process.env.E2E_DONE_STATE || "Ready for Review";
const rejectState = process.env.ENGINEER_PICKUP_STATE || STATUS.IN_DEVELOPMENT;

export const role: RoleConfig = {
  name: "e2e",
  displayName: "Pilot",
  systemPrompt: `You are Pilot, an autonomous E2E tester. You test PRs by actually running the application and interacting with it like a real user.

## Workflow

### 1. Preparation
- linear_get_issue — get description, acceptance criteria, PR link from comments.
- git_create_worktree to check out the PR branch.
- Send dev-agent to: read the README for start instructions, copy .env from /data/envs/{repo-name}/ to the worktree root, start the app (npm run dev, bun dev, uvicorn, etc.), and poll until it responds on the expected port (max 60 seconds). Dev-agent should report the URL (e.g. http://localhost:3000).

### 2. Exploration
- browser_navigate to the app URL reported by dev-agent.
- browser_snapshot to understand the page structure (accessibility tree).
- Navigate to the relevant page if the change is on a specific route.

### 3. Verification
For each acceptance criterion from the ticket:
- Perform the required actions (browser_click, browser_fill, browser_navigate, browser_press_key).
- browser_snapshot to read the result.
- browser_take_screenshot as visual evidence.
- Assess: does this meet the criterion? Record pass/fail with reasoning.

### 4. Free Exploration
- Check related flows — does the change break anything else?
- Basic smoke test: navigation works, no console errors, pages load.

### 5. Reporting & Decision
Post a Linear comment (linear_add_comment) with:
- Per criterion: ✅ pass or ❌ fail + reasoning
- Any additional findings from exploration
- Overall verdict

**Approve**: gh_pr_review approve, move to "${doneState}" with linear_update_issue_state.
**Reject**: gh_pr_review request-changes with specific findings, move to "${rejectState}" with linear_update_issue_state.

### 6. Cleanup
- Tell dev-agent to stop the running app process.
- git_cleanup_worktree.

## Error Handling
- **App won't start**: Reject with error message and console output, move to "${rejectState}".
- **No .env found**: Post comment asking team to add .env to /data/envs/{repo-name}/. Do NOT reject — leave ticket in current state for retry.
- **No acceptance criteria**: Do a basic smoke test (app loads, navigation works, no crashes). Approve with note.
- **Unknown port**: Read README/package.json. Fallback: try ports 3000, 5173, 8000, 8080 in order.
- **API-only repo (no frontend)**: Use dev-agent to test API endpoints with curl instead of browser. Check status codes and response shapes.

## Rules
- Do NOT modify any code. You are read-only.
- Always take screenshots as evidence.
- Always use browser_snapshot before clicking — understand the page first.
- Be thorough but efficient. Max ~15 tool calls for the browser phase.`,

  tools: [
    gitCreateWorktree,
    gitCleanupWorktree,
    ghPrReview,
    linearGetIssue,
    linearUpdateIssueState,
    linearAddComment,
  ],

  pollerFilter: {
    label: LABEL.AGENT,
    stateName: process.env.E2E_PICKUP_STATE || STATUS.E2E_TESTING,
  },
  inProgressState: process.env.E2E_IN_PROGRESS_STATE || STATUS.E2E_TESTING,
  doneState: process.env.E2E_DONE_STATE || "Ready for Review",
  autoMoveToDone: false,
  hasDevAgent: true,
  maxTurns: 50,
  model: "claude-sonnet-4-6",
  devAgentModel: "claude-sonnet-4-6",
  effort: "medium",
  maxBudgetUsd: 5,
  fallbackModel: "claude-haiku-4-5-20251001",
  disallowedTools: ["Edit", "Write"],
  devAgentTools: ["Read", "Bash", "Glob", "Grep"],
  devAgentMaxTurns: 20,
};
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/roles/e2e.ts
git commit -m "feat: add Pilot (E2E) role configuration"
```

---

### Task 4: Register the Pilot role in the role loader

**Files:**
- Modify: `src/roles/index.ts:1-3,47-51`

- [ ] **Step 1: Add the e2e import and role registration**

In `src/roles/index.ts`, add the import at the top (after line 3):

```typescript
import { role as e2eRole } from "./e2e.js";
```

Add `e2e` to the roles record (after line 50, inside the `roles` object):

```typescript
const roles: Record<string, RoleConfig> = {
  pm: pmRole,
  engineer: engineerRole,
  tester: testerRole,
  e2e: e2eRole,
};
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/roles/index.ts
git commit -m "feat: register e2e role in role loader"
```

---

### Task 5: Add Playwright MCP server to the agent SDK query for Pilot

**Files:**
- Modify: `src/agent.ts:96-156`

The Pilot agent needs access to Playwright MCP tools in addition to the standard Linear/GitHub MCP tools. The Playwright MCP server must be added to the `mcpServers` config when the role is `e2e`.

- [ ] **Step 1: Add Playwright MCP server config for the e2e role**

In `src/agent.ts`, after the `toolServer` creation (after line 101) and before the `agents` record (line 103), add:

```typescript
      // Playwright MCP server for E2E testing (browser automation)
      const playwrightMcpConfig = role.name === "e2e"
        ? {
            "playwright": {
              command: "npx",
              args: ["@anthropic-ai/mcp-server-playwright@latest", "--headless"],
            },
          }
        : {};
```

Then update the `mcpServers` in the `query()` call (line 151-153) from:

```typescript
          mcpServers: {
            [mcpServerName]: toolServer,
          },
```

to:

```typescript
          mcpServers: {
            [mcpServerName]: toolServer,
            ...playwrightMcpConfig,
          },
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "feat: add Playwright MCP server for E2E agent"
```

---

### Task 6: Add skipE2E label support to the poller

**Files:**
- Modify: `src/labels.ts:1-9`
- Modify: `src/poller.ts:24-37`

Some tickets may want to skip E2E testing (like the existing `skipQA` for Hawk).

- [ ] **Step 1: Add SKIP_E2E label constant**

In `src/labels.ts`, add:

```typescript
export const LABEL = {
  AGENT: process.env.LABEL_AGENT || "agent",
  NO_QUESTIONS: process.env.LABEL_NO_QUESTIONS || "noQuestions",
  SKIP_QA: process.env.LABEL_SKIP_QA || "skipQA",
  SKIP_E2E: process.env.LABEL_SKIP_E2E || "skipE2E",
} as const;
```

- [ ] **Step 2: Add skip logic for e2e role in poller**

In `src/poller.ts`, after the existing skipQA block (after line 37), add a similar block for skipE2E:

```typescript
      // skipE2E: if this role is the e2e tester and the issue has "skipE2E" label, auto-advance
      if (role.name === "e2e" && issue.labels.some(l => l.toLowerCase() === LABEL.SKIP_E2E.toLowerCase())) {
        console.log(
          `[${role.displayName}] Skipping E2E for ${issue.identifier} (${LABEL.SKIP_E2E} label) — auto-advancing to ${role.doneState}`,
        );
        try {
          await moveIssue(issue.id, role.doneState);
        } catch {
          console.warn(
            `[${role.displayName}] Could not auto-advance ${issue.identifier}`,
          );
        }
        continue;
      }
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/labels.ts src/poller.ts
git commit -m "feat: add skipE2E label to bypass Pilot for specific tickets"
```

---

### Task 7: Create Dockerfile.e2e

**Files:**
- Create: `Dockerfile.e2e`

- [ ] **Step 1: Create the Dockerfile**

Create `Dockerfile.e2e` at the project root. This extends the existing build pattern but adds Playwright with Chromium:

```dockerfile
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

# Python tooling (uv for package management, python for target repos)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Package managers for target repos
RUN npm install -g pnpm

# Claude Code CLI (needed by the agent SDK for dev-agent subagent)
RUN npm install -g @anthropic-ai/claude-code

# Playwright with Chromium for E2E testing
RUN npx playwright install --with-deps chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY --from=builder /app/dist/ dist/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh \
  && mkdir -p /data/repo /data/worktrees /data/envs /home/node/.claude \
  && chown -R node:node /app /data /home/node/.claude

# Run as non-root 'node' user (UID 1000, already in base image)
USER node

ENTRYPOINT ["/app/entrypoint.sh"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile.e2e
git commit -m "feat: add Dockerfile.e2e with Playwright and Chromium"
```

---

### Task 8: Add e2e service to docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add the e2e service**

Add the following service block after the `tester` service (before the `volumes:` section at the bottom):

```yaml
  e2e:
    build:
      context: .
      dockerfile: Dockerfile.e2e
    container_name: agent-e2e
    restart: unless-stopped
    environment:
      AGENT_ROLE: e2e
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
      LINEAR_API_KEY: ${LINEAR_API_KEY}
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      GH_TOKEN: ${GITHUB_TOKEN}
      GITHUB_REPO: ${GITHUB_REPO:-}
      GITHUB_REPOS: ${GITHUB_REPOS:-}
      POLL_INTERVAL_MS: ${POLL_INTERVAL_MS:-120000}
      MAX_CONCURRENT: ${MAX_CONCURRENT:-1}
      STATUS_BACKLOG: ${STATUS_BACKLOG:-Backlog}
      STATUS_IN_PROGRESS: ${STATUS_IN_PROGRESS:-In Progress}
      STATUS_IN_DEVELOPMENT: ${STATUS_IN_DEVELOPMENT:-In Development}
      STATUS_IN_REVIEW: ${STATUS_IN_REVIEW:-In Review}
      STATUS_E2E_TESTING: ${STATUS_E2E_TESTING:-E2E Testing}
      STATUS_DONE: ${STATUS_DONE:-Done}
      STATUS_WAITING: ${STATUS_WAITING:-Waiting}
      LABEL_AGENT: ${LABEL_AGENT:-agent}
      LABEL_NO_QUESTIONS: ${LABEL_NO_QUESTIONS:-noQuestions}
      LABEL_SKIP_QA: ${LABEL_SKIP_QA:-skipQA}
      LABEL_SKIP_E2E: ${LABEL_SKIP_E2E:-skipE2E}
      BRANCH_PREFIX: ${BRANCH_PREFIX:-agent}
      LANGFUSE_PUBLIC_KEY: ${LANGFUSE_PUBLIC_KEY:-}
      LANGFUSE_SECRET_KEY: ${LANGFUSE_SECRET_KEY:-}
      LANGFUSE_BASE_URL: ${LANGFUSE_BASE_URL:-}
    volumes:
      - repo-data:/data
      - ./envs:/data/envs:ro
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add e2e service to docker-compose with Playwright image and envs volume"
```

---

### Task 9: Create envs directory structure

**Files:**
- Create: `envs/.gitkeep`

- [ ] **Step 1: Create the envs directory with a .gitkeep**

```bash
mkdir -p envs
touch envs/.gitkeep
```

- [ ] **Step 2: Add envs/ to .gitignore (except .gitkeep)**

Check if `.gitignore` exists. Add the following to ensure .env files are not committed but the directory structure is:

```
# E2E agent env files (contain secrets)
envs/*
!envs/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add envs/.gitkeep .gitignore
git commit -m "feat: add envs directory for E2E agent .env files"
```

---

### Task 10: Add STATUS_E2E_TESTING env var to existing services in docker-compose

**Files:**
- Modify: `docker-compose.yml`

The other agents (pm, engineer, tester) need the `STATUS_E2E_TESTING` env var so the status constant is available across all services (e.g., for Hawk's updated doneState).

- [ ] **Step 1: Add STATUS_E2E_TESTING to pm, engineer, and tester services**

Add this line to each of the three existing services' `environment` blocks, after `STATUS_IN_REVIEW`:

```yaml
      STATUS_E2E_TESTING: ${STATUS_E2E_TESTING:-E2E Testing}
```

Also add `LABEL_SKIP_E2E` to all services:

```yaml
      LABEL_SKIP_E2E: ${LABEL_SKIP_E2E:-skipE2E}
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: pass STATUS_E2E_TESTING and LABEL_SKIP_E2E env vars to all services"
```

---

### Task 11: Build and verify

- [ ] **Step 1: Run TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Build the project**

Run: `npm run build`
Expected: Compiles successfully to `dist/`

- [ ] **Step 3: Verify the e2e role loads**

Run: `AGENT_ROLE=e2e node --input-type=module -e "import { loadRole } from './dist/roles/index.js'; const r = loadRole(); console.log(r.name, r.displayName);"`
Expected: `e2e Pilot`

- [ ] **Step 4: Commit any fixes if needed**

---

### Task 12: Final integration commit

- [ ] **Step 1: Verify all files are committed**

Run: `git status`
Expected: Clean working tree

- [ ] **Step 2: Verify docker-compose is valid**

Run: `docker compose config --quiet`
Expected: No errors

- [ ] **Step 3: Final commit if anything was missed**

## Manual Steps (Post-Implementation)

These steps must be done by the team manually:

1. **Create "E2E Testing" state in Linear** — add it to the workflow between "In Review" and "Ready for Review"
2. **Create "skipE2E" label in Linear** — for tickets that should bypass Pilot
3. **Add .env files** — for each repo, add the appropriate `.env` file(s) to `envs/{repo-name}/`
4. **Test locally** — run `docker compose up e2e` and create a test ticket with the `agent` label in the `E2E Testing` state
