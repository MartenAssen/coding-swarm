import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const REPO_DIR = process.env.REPO_DIR ?? "/data/repo";

async function installDeps(dir: string) {
  // JS/TS dependencies
  if (existsSync(join(dir, "package.json"))) {
    let cmd: string;
    let args: string[];
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) {
      cmd = "bun";
      args = ["install", "--frozen-lockfile"];
    } else if (existsSync(join(dir, "pnpm-lock.yaml"))) {
      cmd = "pnpm";
      args = ["install", "--frozen-lockfile"];
    } else if (existsSync(join(dir, "yarn.lock"))) {
      cmd = "yarn";
      args = ["install", "--frozen-lockfile"];
    } else {
      cmd = "npm";
      args = ["ci"];
    }
    console.log(`[worktree] Installing JS dependencies with ${cmd} in ${dir}`);
    await exec(cmd, args, { cwd: dir, timeout: 120_000 });
  }

  // Python dependencies
  if (existsSync(join(dir, "pyproject.toml"))) {
    console.log(`[worktree] Installing Python dependencies with uv in ${dir}`);
    await exec("uv", ["sync"], { cwd: dir, timeout: 120_000 });
  }

}

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
    await installDeps(worktreeDir);
    return { content: [{ type: "text" as const, text: `Worktree created at ${worktreeDir} on branch ${branch} (dependencies installed)` }] };
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
  "Create a GitHub pull request using the gh CLI. Use labels to categorize the PR (e.g. 'bug', 'feature').",
  {
    title: z.string().describe("PR title"),
    body: z.string().describe("PR body in markdown"),
    head: z.string().describe("Head branch name"),
    base: z.string().default("main").describe("Base branch name"),
    labels: z.array(z.string()).default([]).describe("Labels to apply to the PR, e.g. ['bug'] or ['feature']"),
  },
  async ({ title, body, head, base, labels }) => {
    const repo = process.env.GITHUB_REPO;
    if (!repo) throw new Error("GITHUB_REPO not set (e.g. 'owner/repo')");
    const worktreeDir = `/data/worktrees/${head}`;
    const args = ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", head, "--repo", repo];
    if (labels.length > 0) {
      args.push("--label", labels.join(","));
    }
    const result = await run("gh", args, worktreeDir);
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
