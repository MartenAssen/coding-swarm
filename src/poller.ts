import { execSync } from "node:child_process";
import type { RoleConfig } from "./roles/index.js";
import { queryIssues, moveIssue } from "./tools/linear.js";
import { invokeAgent, type AgentResult } from "./agent.js";
import { getRepoForIssue, getRepoLabels, type RepoConfig } from "./repos.js";
import { STATUS } from "./statuses.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2 * 60 * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 1;

/** Issues currently being worked on — prevents double-pickup */
const activeIssues = new Set<string>();

async function poll(role: RoleConfig) {
  try {
    // queryIssues already returns results sorted by priority (urgent first)
    const issues = await queryIssues(role.pollerFilter);

    for (const issue of issues) {
      if (activeIssues.has(issue.id)) continue;

      // skipQA: if this role is the tester and the issue has "skipqa" label, auto-advance
      if (role.name === "tester" && issue.labels.includes("skipqa")) {
        console.log(
          `[${role.displayName}] Skipping QA for ${issue.identifier} (skipQA label) — auto-advancing to ${role.doneState}`,
        );
        try {
          await moveIssue(issue.id, role.doneState);
        } catch {
          console.warn(`[${role.displayName}] Could not auto-advance ${issue.identifier}`);
        }
        continue;
      }

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

      // Respect concurrency limit
      if (activeIssues.size >= MAX_CONCURRENT) {
        console.log(
          `[${role.displayName}] At concurrency limit (${MAX_CONCURRENT}), deferring ${issue.identifier} (priority ${issue.priority})`,
        );
        break; // Issues are sorted by priority, so remaining ones are lower priority
      }

      console.log(
        `[${role.displayName}] Picking up ${issue.identifier}: ${issue.title} (repo: ${repoConfig.label}, priority: ${issue.priority}, state: ${issue.stateName})`,
      );
      activeIssues.add(issue.id);

      // Try to move to in-progress state (acts as a lock if Linear is writable)
      try {
        await moveIssue(issue.id, role.inProgressState);
      } catch (err) {
        console.warn(
          `[${role.displayName}] Could not move ${issue.identifier} to ${role.inProgressState} (read-only?), proceeding anyway`,
        );
      }

      // Process the issue (don't await — let the poller continue for other issues)
      processIssue(role, issue, repoConfig).finally(() => {
        activeIssues.delete(issue.id);
      });
    }
  } catch (err) {
    console.error(`[${role.displayName}] Polling error:`, err);
  }
}

async function processIssue(
  role: RoleConfig,
  issue: { id: string; identifier: string; title: string; stateName: string; labels: string[]; priority: number },
  repoConfig: RepoConfig,
) {
  const prompt = `You have been assigned Linear issue ${issue.identifier}: "${issue.title}".

Fetch the full issue details using linear_get_issue, then follow your workflow to complete the task.

Issue identifier: ${issue.identifier}`;

  try {
    // Ensure the repo is up to date before starting work
    const repoDir = repoConfig.repoDir;
    try {
      console.log(`[${role.displayName}] Syncing repo ${repoConfig.label} before starting ${issue.identifier}`);
      execSync("git fetch origin && git pull --ff-only", {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch (err) {
      console.warn(
        `[${role.displayName}] Git sync failed (continuing anyway):`,
        err instanceof Error ? err.message : String(err),
      );
    }

    console.log(`[${role.displayName}] Starting work on ${issue.identifier}`);
    const result = await invokeAgent(prompt, role, repoConfig);

    // Log cost to console
    const durationStr = `${Math.round(result.durationMs / 1000)}s`;
    console.log(
      `[${role.displayName}] Completed ${issue.identifier}: ${result.numTurns} turns, $${result.costUsd.toFixed(2)}, ${durationStr}`,
    );

    // Post cost summary as Linear comment
    try {
      const { LinearClient } = await import("@linear/sdk");
      const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });
      const minutes = Math.round(result.durationMs / 60_000);
      await client.createComment({
        issueId: issue.id,
        body: `**${role.displayName} completed** — ${result.numTurns} turns, $${result.costUsd.toFixed(2)}, ${minutes}m`,
      });
    } catch {
      // Best effort
    }

    // Try to move to done state (unless the agent manages its own transitions)
    if (role.autoMoveToDone !== false) {
      try {
        await moveIssue(issue.id, role.doneState);
        console.log(
          `[${role.displayName}] Moved ${issue.identifier} to ${role.doneState}`,
        );
      } catch {
        console.warn(
          `[${role.displayName}] Could not move ${issue.identifier} to ${role.doneState} (read-only?)`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[${role.displayName}] Error processing ${issue.identifier}:`,
      err,
    );
    // Try to add a comment about the failure
    try {
      const { LinearClient } = await import("@linear/sdk");
      const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });
      await client.createComment({
        issueId: issue.id,
        body: `**${role.displayName} agent failed:**\n\n\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``,
      });
    } catch {
      // Best effort
    }
  }
}

export function startPoller(role: RoleConfig) {
  const stateNames = Array.isArray(role.pollerFilter.stateName)
    ? role.pollerFilter.stateName.join("' or '")
    : role.pollerFilter.stateName;
  console.log(
    `[${role.displayName}] Starting poller — checking for '${stateNames}'${role.pollerFilter.label ? ` with label '${role.pollerFilter.label}'` : ""} every ${POLL_INTERVAL_MS / 1000}s (max concurrent: ${MAX_CONCURRENT})`,
  );

  // Initial poll immediately
  poll(role);

  // Then poll on interval
  setInterval(() => poll(role), POLL_INTERVAL_MS);
}
