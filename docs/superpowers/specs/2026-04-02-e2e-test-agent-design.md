# E2E Test Agent (Pilot) — Design Spec

## Overview

A fourth agent in the Jupietre pipeline that performs functional end-to-end testing by actually starting the application and interacting with it via a browser, like a real user would.

## Pipeline Position

```
Backlog → Scout (PM) → In Development → Forge (Engineer) → In Review → Hawk (QA) → E2E Testing → Pilot (E2E) → Ready for Review → Done
```

Pilot sits after Hawk. Hawk is the fast code-review gatekeeper; Pilot is the functional verification step.

### State Transitions

- **Pickup state:** `E2E Testing`
- **In-progress state:** `E2E Testing`
- **On success:** → `Ready for Review`
- **On failure:** → `In Development` (back to Forge for fixes)

### Hawk Adjustment

Hawk's `doneState` changes from `Ready for Review` to `E2E Testing`.

## Agent Configuration

| Field | Value |
|---|---|
| **Name** | `e2e` |
| **Display Name** | Pilot |
| **Model** | Claude Sonnet 4.6 |
| **Budget** | $5 per ticket |
| **Max Turns** | 50 |
| **Has Dev-Agent** | Yes |
| **Dev-Agent Model** | Sonnet 4.6 |
| **Dev-Agent Max Turns** | 20 |
| **Dev-Agent Tools** | Read, Bash, Glob, Grep (no Edit/Write) |
| **Effort** | Medium |
| **Disallowed Tools** | Edit, Write |

### Pilot's MCP Tools (Linear + GitHub)

- `linearGetIssue` — ticket + acceptance criteria
- `linearUpdateIssueState` — state transitions
- `linearAddComment` — post findings + screenshots
- `gitCreateWorktree` — checkout PR branch
- `gitCleanupWorktree` — cleanup
- `ghPrReview` — approve or request-changes

### Playwright MCP Tools (Browser)

- `browser_navigate` — go to URL
- `browser_snapshot` — read accessibility tree
- `browser_take_screenshot` — visual evidence
- `browser_click` — click elements
- `browser_fill` — fill forms
- `browser_press_key` — keyboard actions
- `browser_wait_for` — wait for elements

## Workflow

### Phase 1: Preparation

1. `linear_get_issue` — fetch ticket, read acceptance criteria and PR link from comments
2. `git_create_worktree` — checkout the PR branch
3. Dev-agent reads README for start instructions
4. Dev-agent copies `.env` from `/data/envs/{repo-name}/` to the worktree
5. Dev-agent starts the app (`npm run dev`, `bun dev`, `uvicorn`, etc.)
6. Dev-agent health checks — polls until the app responds (max 60 seconds, then fail)

### Phase 2: Exploration

7. `browser_navigate` to the app (localhost + correct port)
8. `browser_snapshot` — understand page structure
9. Navigate to the relevant page if the change is on a specific route

### Phase 3: Verification per Acceptance Criterion

10. For each criterion from the ticket:
    - Perform required actions (click, fill, navigate)
    - `browser_snapshot` to read the result
    - `browser_take_screenshot` as evidence
    - Assess: does this meet the criterion? Yes/No + reasoning

### Phase 4: Free Exploration

11. Check related flows — does the change break anything else?
12. Basic smoke test: navigation works, no crashes, page loads

### Phase 5: Reporting & Decision

13. Post a Linear comment with:
    - Per criterion: pass/fail + screenshot
    - Any additional findings
    - Overall verdict: approve or reject
14. **On approve:** `gh_pr_review approve` + move to `Ready for Review`
15. **On reject:** `gh_pr_review request-changes` with specific findings + move to `In Development`

### Phase 6: Cleanup

16. Dev-agent stops the app (kill process)
17. `git_cleanup_worktree`

## Docker Setup

### Separate Dockerfile (`Dockerfile.e2e`)

Extends the base image with Playwright + Chromium. Keeps the existing agents lightweight.

### Docker Compose Service

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
    LINEAR_API_KEY: ${LINEAR_API_KEY}
    GITHUB_TOKEN: ${GITHUB_TOKEN}
    GITHUB_REPO: ${GITHUB_REPO:-}
    GITHUB_REPOS: ${GITHUB_REPOS:-}
    POLL_INTERVAL_MS: ${POLL_INTERVAL_MS:-120000}
    MAX_CONCURRENT: ${MAX_CONCURRENT:-1}
    STATUS_E2E_TESTING: ${STATUS_E2E_TESTING:-E2E Testing}
    STATUS_DONE: ${STATUS_DONE:-Ready for Review}
    STATUS_IN_DEVELOPMENT: ${STATUS_IN_DEVELOPMENT:-In Development}
    LABEL_AGENT: ${LABEL_AGENT:-agent}
    LABEL_SKIP_QA: ${LABEL_SKIP_QA:-skipQA}
    BRANCH_PREFIX: ${BRANCH_PREFIX:-agent}
  volumes:
    - repo-data:/data
    - ./envs:/data/envs:ro
```

### .env Files Structure

```
envs/
  repo-name-1/
    .env
  repo-name-2/
    .env
    .env.local
```

Managed locally by the team. Read-only mount in the container.

### Playwright MCP Server

Runs inside the container as an MCP server configured in the agent SDK query. Connects to headless Chromium installed via Playwright. The Playwright MCP server is added to the `mcpServers` config alongside the existing Linear/GitHub MCP server.

### Screenshots in Linear Comments

Playwright's `browser_take_screenshot` returns base64-encoded images. These are posted as inline markdown images in Linear comments using the existing Linear API attachment upload, or described textually if upload is not available. Implementation will follow the pattern already used in `linearGetIssue` for base64 image handling.

## Error Handling

### App fails to start
- Dev-agent polls for max 60 seconds on the expected port
- If app doesn't start: reject with error message and console output
- Ticket moves to `In Development`

### No .env found for repo
- Post Linear comment: "No .env found for {repo}. Add to `/data/envs/{repo-name}/`"
- Ticket stays in `E2E Testing` — not a code problem, will be retried next poll

### No acceptance criteria in ticket
- Agent performs a basic smoke test: app loads, no crashes, navigation works
- Approve with note: "No specific acceptance criteria found, smoke test passed"

### Unknown app port
- Dev-agent reads README/package.json for port info
- Fallback: tries common ports (3000, 5173, 8000, 8080)
- If nothing works: reject with "Could not determine app port"

### Timeout
- Max 10 minutes per ticket (enforced by budget + turn limits)
- On timeout: failure comment posted to Linear

### API-only repos (no frontend)
- Agent detects from README or project structure
- Tests API endpoints via dev-agent (curl) instead of browser
- Basic checks: endpoint responds, correct status codes, expected response shape

## New Linear State Required

- `E2E Testing` — create this state in the Linear workflow between `In Review` and `Ready for Review`

## New Environment Variables

- `STATUS_E2E_TESTING` — the pickup state name for Pilot (default: "E2E Testing")

## Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `src/roles/e2e.ts` | Create | Pilot role configuration and system prompt |
| `src/roles/index.ts` | Modify | Add `e2e` to role loader |
| `src/statuses.ts` | Modify | Add `E2E_TESTING` status |
| `src/roles/qa.ts` | Modify | Change Hawk's `doneState` to `E2E Testing` |
| `Dockerfile.e2e` | Create | Dockerfile with Playwright + Chromium |
| `docker-compose.yml` | Modify | Add `e2e` service |
| `envs/` | Create | Directory structure for .env files per repo |
