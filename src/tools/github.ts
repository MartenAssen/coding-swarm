import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const REPO_DIR = process.env.REPO_DIR ?? "/data/repo";

async function run(cmd: string, args: string[], cwd?: string) {
  const { stdout, stderr } = await exec(cmd, args, {
    cwd: cwd ?? REPO_DIR,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "",
    },
    timeout: 60_000,
  });
  if (stderr) return `${stdout}\n${stderr}`.trim();
  return stdout.trim();
}

export const gitCreateWorktree = tool(
  "git_create_worktree",
  "Create a git worktree for isolated development on a new branch.",
  {
    branch: z.string().describe("New branch name, e.g. 'agent/FOO-123'"),
    baseBranch: z.string().default("main").describe("Base branch to fork from"),
  },
  async ({ branch, baseBranch }) => {
    const worktreeDir = `/data/worktrees/${branch}`;
    await run("git", ["fetch", "origin", baseBranch]);
    await run("git", ["worktree", "add", "-b", branch, worktreeDir, `origin/${baseBranch}`]);
    return { content: [{ type: "text" as const, text: `Worktree created at ${worktreeDir} on branch ${branch}` }] };
  },
);

export const gitPushBranch = tool(
  "git_push_branch",
  "Push a branch to the remote origin.",
  {
    branch: z.string().describe("Branch name to push"),
  },
  async ({ branch }) => {
    const worktreeDir = `/data/worktrees/${branch}`;
    const result = await run("git", ["push", "origin", branch], worktreeDir);
    return { content: [{ type: "text" as const, text: result || "Pushed successfully" }] };
  },
);

export const ghCreatePR = tool(
  "gh_create_pr",
  "Create a GitHub pull request using the gh CLI.",
  {
    title: z.string().describe("PR title"),
    body: z.string().describe("PR body in markdown"),
    head: z.string().describe("Head branch name"),
    base: z.string().default("main").describe("Base branch name"),
  },
  async ({ title, body, head, base }) => {
    const repo = process.env.GITHUB_REPO;
    if (!repo) throw new Error("GITHUB_REPO not set (e.g. 'owner/repo')");
    const worktreeDir = `/data/worktrees/${head}`;
    const result = await run("gh", ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", head, "--repo", repo], worktreeDir);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

export const gitCleanupWorktree = tool(
  "git_cleanup_worktree",
  "Remove a git worktree after work is complete.",
  {
    branch: z.string().describe("Branch name whose worktree to remove"),
  },
  async ({ branch }) => {
    const worktreeDir = `/data/worktrees/${branch}`;
    await run("git", ["worktree", "remove", worktreeDir]);
    return { content: [{ type: "text" as const, text: `Worktree removed for ${branch}` }] };
  },
);

export const ghPrReview = tool(
  "gh_pr_review",
  "Approve or request changes on a GitHub pull request.",
  {
    prNumber: z.number().describe("PR number"),
    action: z.enum(["approve", "request-changes"]).describe("Review action"),
    body: z.string().describe("Review comment body in markdown"),
  },
  async ({ prNumber, action, body }) => {
    const repo = process.env.GITHUB_REPO;
    if (!repo) throw new Error("GITHUB_REPO not set (e.g. 'owner/repo')");
    const flag = action === "approve" ? "--approve" : "--request-changes";
    const result = await run("gh", ["pr", "review", String(prNumber), flag, "--body", body, "--repo", repo]);
    return { content: [{ type: "text" as const, text: result || `PR #${prNumber} reviewed (${action})` }] };
  },
);
