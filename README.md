# Jupietre

Autonomous AI agent team that processes Linear tickets end-to-end. Built on the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview).

Three agents poll Linear for tickets with the `agent` label and move them through a pipeline (state names are [configurable via env vars](#environment-variables)):

```
Backlog → [Joseph: PM] → In Development → [Pieter: Engineer] → In Review → [Hassan: QA] → Done
```

## Agents

### Joseph (PM)

Picks up tickets in **Backlog**. Reads the ticket, researches external APIs via web search, enriches the description with file paths, acceptance criteria, test cases, and a coding prompt, then moves to **In Development**.

- Model: Haiku 4.5 | Budget: $2/ticket
- Can ask clarifying questions via Linear comments (skipped with `noQuestions` label)
- Can split large tickets into sub-issues

### Pieter (Engineer)

Picks up tickets in **In Development**. Creates a git worktree, plans the implementation, then executes step-by-step using a dev-agent subagent. Pushes a branch, creates a PR, and moves to **In Review**.

- Model: Opus 4.6 | Budget: $15/ticket
- Dev-agent (Sonnet) handles file operations, max 50 turns per step
- One step per dev-agent call — never dumps the whole task at once

### Hassan (QA)

Picks up tickets in **In Review**. Compares the PR diff against ticket requirements. Approves or rejects with specific feedback. Moves to **Done** or back to **In Development**.

- Model: Sonnet 4.6 | Budget: $3/ticket
- Read-only dev-agent for diff retrieval
- Skipped entirely with `skipQA` label (auto-advances to Done)

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Poller     │────▶│  Agent SDK   │────▶│  Linear API │
│  (per role)  │     │   query()    │     │  (MCP tools) │
└─────────────┘     └──────┬───────┘     └─────────────┘
                           │
                    ┌──────▼───────┐     ┌─────────────┐
                    │  Dev-Agent   │────▶│  GitHub API  │
                    │  (subagent)  │     │  (MCP tools) │
                    └──────────────┘     └─────────────┘
```

- **Poller** checks Linear every 2 minutes for matching tickets
- **MCP tools** provide Linear and GitHub operations (get/update issues, create PRs, review PRs)
- **Dev-agent** is a Claude Code subagent with file system access, scoped per role
- **settingSources: ["project"]** loads each target repo's `CLAUDE.md` automatically
- **Hooks** provide MCP audit trail and subagent tracking
- **Cost tracking** logs per-ticket cost to console and posts a summary comment on Linear

## Supported Project Types

Dependencies are auto-detected by lock file when creating worktrees:

| Ecosystem | Detection | Install Command |
|-----------|-----------|-----------------|
| bun | `bun.lockb` / `bun.lock` | `bun install --frozen-lockfile` |
| pnpm | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| yarn | `yarn.lock` | `yarn install --frozen-lockfile` |
| npm | `package.json` (fallback) | `npm ci` |
| Python | `pyproject.toml` | `uv sync` |

## Setup

### Environment Variables

```bash
# Required — pick ONE authentication method:
CLAUDE_CODE_OAUTH_TOKEN=...       # OAuth token from Max/Pro subscription (run `claude setup-token`)
ANTHROPIC_API_KEY=sk-ant-...       # OR: Claude API key (pay-per-token billing)
LINEAR_API_KEY=lin_api_...         # Linear API key
GITHUB_TOKEN=ghp_...              # GitHub token for cloning and PRs
GITHUB_REPO=owner/repo            # Target repository (e.g. 'acme/webapp')
AGENT_ROLE=engineer                # Which agent to run: pm, engineer, tester

# Optional
REPO_DIR=/data/repo               # Where to clone the repo (default: /data/repo)
POLL_INTERVAL_MS=120000           # Poll interval in ms (default: 2 minutes)
MAX_CONCURRENT=1                  # Max concurrent issues per agent (default: 1)
LANGFUSE_PUBLIC_KEY=...           # Langfuse tracing (optional)
LANGFUSE_SECRET_KEY=...
LANGFUSE_BASE_URL=...

# Linear label names (override if your workspace uses different labels)
LABEL_AGENT=agent                 # Poller only picks up issues with this label
LABEL_NO_QUESTIONS=noQuestions    # PM skips clarification when this label is present
LABEL_SKIP_QA=skipQA              # QA is skipped, ticket auto-advances to Done

# Linear workflow state names (override if your workspace uses different names)
STATUS_BACKLOG=Backlog            # PM picks up from here
STATUS_IN_PROGRESS=In Progress    # PM working state
STATUS_IN_DEVELOPMENT=In Development  # Engineer picks up from here
STATUS_IN_REVIEW=In Review        # QA picks up from here
STATUS_DONE=Done                  # Final state
STATUS_WAITING=Waiting            # PM waiting for clarification
```

### Docker

```bash
docker build -t jupietre .

# Run with OAuth token (Max/Pro subscription)
docker run -e AGENT_ROLE=pm \
  -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -e LINEAR_API_KEY=... \
  -e GITHUB_TOKEN=... \
  -e GITHUB_REPO=owner/repo \
  jupietre

# Or run with API key
docker run -e AGENT_ROLE=pm \
  -e ANTHROPIC_API_KEY=... \
  -e LINEAR_API_KEY=... \
  -e GITHUB_TOKEN=... \
  -e GITHUB_REPO=owner/repo \
  jupietre

# Run all three as separate containers
docker compose up
```

### Local Development

```bash
npm install
npm run dev   # runs with tsx
```

## Linear Labels

| Label | Effect |
|-------|--------|
| `agent` | **Required.** Tickets without this label are ignored. |
| `noQuestions` | PM skips clarification — makes reasonable assumptions and proceeds. |
| `skipQA` | QA is skipped entirely — ticket auto-advances from In Review to Done. |

## Project Structure

```
src/
├── index.ts              # Entry point — loads role, starts poller
├── agent.ts              # SDK query wrapper with hooks and cost tracking
├── poller.ts             # Polls Linear, dispatches agents, tracks costs
├── statuses.ts           # Linear workflow state names (env-configurable)
├── roles/
│   ├── index.ts          # RoleConfig interface and role loader
│   ├── pm.ts             # Joseph — ticket prep and enrichment
│   ├── engineer.ts       # Pieter — implementation via dev-agent
│   └── qa.ts             # Hassan — PR review against requirements
├── tools/
│   ├── linear.ts         # Linear MCP tools (get/update/comment/create issues)
│   └── github.ts         # GitHub MCP tools (worktrees, PRs, reviews)
└── lib/
    └── tracing.ts        # Langfuse/OpenTelemetry tracing
```

## SDK Features Used

| Feature | Purpose |
|---------|---------|
| `settingSources: ["project"]` | Loads target repo's CLAUDE.md for project conventions |
| `effort` | Tunes thinking depth per role (low/medium/high) |
| `maxBudgetUsd` | Prevents runaway costs per session |
| `fallbackModel` | Automatic failover when primary model is rate-limited |
| `disallowedTools` | Blocks tools per role (PM can't edit files, QA can't write) |
| `hooks` (PostToolUse) | Audit trail for all MCP tool calls |
| `hooks` (SubagentStop) | Tracks dev-agent completion |
| `criticalSystemReminder_EXPERIMENTAL` | Enforces TDD and verification on dev-agent |
| `mcpServers` on dev-agent | Shares Linear tools so dev-agent can post progress |
