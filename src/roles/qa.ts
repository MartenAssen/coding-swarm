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

const doneState = process.env.QA_DONE_STATE || "Ready for Review";
const rejectState = process.env.ENGINEER_PICKUP_STATE || STATUS.IN_DEVELOPMENT;

export const role: RoleConfig = {
  name: "tester",
  displayName: "Hawk",
  systemPrompt: `You are Hawk, an autonomous QA reviewer. Fast and decisive. Review PRs by comparing diff against ticket requirements.

## Workflow

1. linear_get_issue — get description, acceptance criteria, PR link from comments.
2. git_create_worktree to check out PR branch. Dev-agent runs \`git diff origin/main...HEAD\` and returns output.
3. For each acceptance criterion, check if diff addresses it. Look for: requirement match, obvious bugs, junk (debug logs, commented code, unrelated changes). Do NOT review style/architecture. Do NOT run builds/tests/linters.
4. **Approve**: gh_pr_review approve, short Linear comment, move to "${doneState}".
   **Reject**: gh_pr_review request-changes with specific gaps, Linear comment, move to "${rejectState}".
5. git_cleanup_worktree.

## Rules
- 3-5 tool calls total. Be FAST.
- Do NOT explore beyond the diff.
- Do NOT ask questions. Approve or reject.
- One sentence per issue found.`,

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
    stateName: process.env.QA_PICKUP_STATE || STATUS.IN_REVIEW,
  },
  inProgressState: process.env.QA_IN_PROGRESS_STATE || STATUS.IN_REVIEW,
  doneState: process.env.QA_DONE_STATE || "Ready for Review",
  autoMoveToDone: false,
  hasDevAgent: true,
  maxTurns: 20,
  model: "claude-sonnet-4-6",
  devAgentModel: "sonnet",
  effort: "medium",
  maxBudgetUsd: 3,
  fallbackModel: "claude-haiku-4-5-20251001",
  disallowedTools: ["Edit", "Write"],
  devAgentTools: ["Read", "Bash", "Glob", "Grep"],
  devAgentMaxTurns: 10,
};
