# Multi-Repo Support Design

## Problem

The system currently supports a single `GITHUB_REPO`. We need to support multiple repos, with each Linear ticket specifying which repo it targets via a label.

## Config

```env
# Comma-separated label:owner/repo pairs
GITHUB_REPOS=paddock-app:Pontifexx-Tech/paddock-app,asset-dm:Pontifexx-Tech/asset-data-manager

# Legacy fallback (optional, used if GITHUB_REPOS is not set)
GITHUB_REPO=Pontifexx-Tech/paddock-app
```

## Linear Ticket Labels

Each ticket needs two labels:
- `agent` — marks it for the agent system (existing behavior)
- `<repo-label>` — e.g. `paddock-app` or `asset-dm`, matches a key in `GITHUB_REPOS`

If a ticket has `agent` but no repo label:
- **PM role**: comments asking which repo, moves to Needs Refinement / WAITING status
- **Other roles**: log warning and skip the issue

## Changes

### 1. New module: `src/repos.ts`

Parses `GITHUB_REPOS` env var into a map. Exports:
- `getRepoForIssue(labels: string[]): { label: string; repo: string; repoDir: string } | null`
- `getAllRepos(): Array<{ label: string; repo: string; repoDir: string }>`
- Falls back to `GITHUB_REPO` / `REPO_DIR` if `GITHUB_REPOS` is not set (backwards compat)
- Repo dirs: `/data/repos/<label>/` (e.g. `/data/repos/paddock-app/`)

### 2. Entrypoint: `entrypoint.sh`

- If `GITHUB_REPOS` is set: parse it, clone each repo into `/data/repos/<label>/`
- If only `GITHUB_REPO` is set: clone into `/data/repo` (legacy behavior)
- Configure git user for each cloned repo

### 3. Poller: `src/poller.ts`

- After picking up an issue, call `getRepoForIssue(issue.labels)`
- If no repo found and role is PM: comment + move to WAITING, skip processing
- If no repo found and role is not PM: warn + skip
- Pass resolved `repoDir` and `repo` (owner/repo string) to `processIssue`
- `processIssue` syncs the correct repo dir before invoking the agent

### 4. Agent: `src/agent.ts`

- `invokeAgent` accepts a new `repoContext: { repoDir: string; repo: string }` parameter
- Sets `cwd` to `repoContext.repoDir`
- Sets `GITHUB_REPO` env var for the agent session (so tools pick up the right repo)

### 5. GitHub tools: `src/tools/github.ts`

- No changes needed — tools already read `process.env.GITHUB_REPO` at call time
- The poller sets `GITHUB_REPO` in the process env before each agent invocation

### 6. Docker: `docker-compose.yml`

- Pass `GITHUB_REPOS` env var to all services
- Keep `GITHUB_REPO` for backwards compatibility
- Shared volume still works — all repos stored under `/data/repos/`

### 7. PM system prompt update: `src/roles/pm.ts`

- Add instruction: if ticket has no repo label, ask which repo and move to WAITING

## Backwards Compatibility

- If `GITHUB_REPOS` is not set, falls back to `GITHUB_REPO` + `/data/repo` (existing behavior)
- No breaking changes for single-repo deployments
