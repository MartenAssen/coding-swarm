import { tool } from "@anthropic-ai/claude-agent-sdk";
import { LinearClient } from "@linear/sdk";
import { z } from "zod";

function getClient(): LinearClient {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("LINEAR_API_KEY not set");
  return new LinearClient({ apiKey });
}

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

const MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Extract image URLs from markdown text (![alt](url) syntax) */
export function extractInlineImages(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    urls.push(match[1]);
  }
  return urls;
}

/** Guess MIME type from URL, or from Content-Type header */
function guessMime(url: string, contentType?: string): string | null {
  if (contentType) {
    const ct = contentType.split(";")[0].trim().toLowerCase();
    if (ct.startsWith("image/")) return ct;
  }
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? null;
}

/** Fetch an image URL and return base64 + mimeType, or null on failure */
async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const mime = guessMime(url, res.headers.get("content-type") ?? undefined);
    if (!mime || !mime.startsWith("image/")) return null;
    const buffer = await res.arrayBuffer();
    return { data: Buffer.from(buffer).toString("base64"), mimeType: mime };
  } catch {
    return null;
  }
}

/** Exported for testing */
export async function getIssueDetails(client: LinearClient, issueId: string) {
    const issue = await client.issue(issueId);
    const state = await issue.state;
    const labels = await issue.labels();
    const comments = await issue.comments();
    const assignee = await issue.assignee;

    const attachments = await issue.attachments();

    const commentTexts = comments.nodes
      .map((c) => `[${c.createdAt.toISOString()}] ${c.body}`)
      .join("\n\n");

    const attachmentTexts = attachments.nodes
      .map((a) => `- [${a.title}](${a.url})${a.subtitle ? ` — ${a.subtitle}` : ""}`)
      .join("\n");

    const text = [
      `**${issue.identifier}: ${issue.title}**`,
      `State: ${state?.name ?? "Unknown"}`,
      `Labels: ${labels.nodes.map((l) => l.name).join(", ") || "none"}`,
      `Assignee: ${assignee?.name ?? "unassigned"}`,
      `Priority: ${issue.priority}`,
      `URL: ${issue.url}`,
      "",
      "## Description",
      issue.description ?? "(no description)",
      "",
      comments.nodes.length > 0 ? `## Comments\n${commentTexts}` : "",
      attachments.nodes.length > 0 ? `## Attachments\n${attachmentTexts}` : "",
    ].join("\n");

    // Collect all image URLs: from attachments, description, and comments
    const imageUrls = new Set<string>();

    for (const a of attachments.nodes) {
      if (guessMime(a.url)) imageUrls.add(a.url);
    }

    for (const url of extractInlineImages(issue.description ?? "")) {
      imageUrls.add(url);
    }
    for (const c of comments.nodes) {
      for (const url of extractInlineImages(c.body ?? "")) {
        imageUrls.add(url);
      }
    }

    // Fetch images in parallel and convert to base64
    const imageResults = await Promise.all(
      [...imageUrls].map((url) => fetchImageAsBase64(url)),
    );

    // Return text content + fetched images as base64 image blocks
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text" as const, text },
    ];

    for (const img of imageResults) {
      if (img) {
        content.push({
          type: "image" as const,
          data: img.data,
          mimeType: img.mimeType,
        });
      }
    }

    return { content };
}

export const linearGetIssue = tool(
  "linear_get_issue",
  "Get details of a Linear issue by ID or identifier (e.g. 'ENG-123').",
  {
    issueId: z.string().describe("Issue ID (UUID) or identifier (e.g. ENG-123)"),
  },
  async ({ issueId }) => getIssueDetails(getClient(), issueId),
);

export const linearUpdateIssueState = tool(
  "linear_update_issue_state",
  "Update the workflow state of a Linear issue.",
  {
    issueId: z.string().describe("Issue ID (UUID) or identifier (e.g. ENG-123)"),
    stateName: z.string().describe("Target state name, e.g. 'In Progress', 'Done', 'Ready for Review'"),
  },
  async ({ issueId, stateName }) => {
    const client = getClient();
    const issue = await client.issue(issueId);
    const team = await issue.team;
    if (!team) throw new Error("Issue has no team");

    const states = await team.states();
    const target = states.nodes.find(
      (s) => s.name.toLowerCase() === stateName.toLowerCase(),
    );
    if (!target) {
      const available = states.nodes.map((s) => s.name).join(", ");
      throw new Error(`State '${stateName}' not found. Available: ${available}`);
    }

    await client.updateIssue(issue.id, { stateId: target.id });
    return {
      content: [{ type: "text" as const, text: `Issue ${issue.identifier} moved to '${target.name}'` }],
    };
  },
);

export const linearAddComment = tool(
  "linear_add_comment",
  "Add a comment to a Linear issue.",
  {
    issueId: z.string().describe("Issue ID (UUID) or identifier (e.g. ENG-123)"),
    body: z.string().describe("Comment body in markdown"),
  },
  async ({ issueId, body }) => {
    const client = getClient();
    const issue = await client.issue(issueId);
    await client.createComment({ issueId: issue.id, body });
    return {
      content: [{ type: "text" as const, text: `Comment added to ${issue.identifier}` }],
    };
  },
);

export const linearUpdateIssue = tool(
  "linear_update_issue",
  "Update a Linear issue's description, title, priority, or labels.",
  {
    issueId: z.string().describe("Issue ID (UUID) or identifier (e.g. ENG-123)"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description (replaces existing). Use linear_get_issue first to read current description and append to it."),
    priority: z.number().optional().describe("Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low"),
    labelNames: z.array(z.string()).optional().describe("Label names to set (replaces existing labels)"),
  },
  async ({ issueId, title, description, priority, labelNames }) => {
    const client = getClient();
    const issue = await client.issue(issueId);

    const update: Record<string, unknown> = {};
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (priority !== undefined) update.priority = priority;

    if (labelNames?.length) {
      const team = await issue.team;
      if (team) {
        const labels = await team.labels();
        update.labelIds = labels.nodes
          .filter((l) => labelNames.some((n) => n.toLowerCase() === l.name.toLowerCase()))
          .map((l) => l.id);
      }
    }

    await client.updateIssue(issue.id, update);
    const fields = Object.keys(update).join(", ");
    return {
      content: [{ type: "text" as const, text: `Updated ${issue.identifier}: ${fields}` }],
    };
  },
);

export const linearCreateIssue = tool(
  "linear_create_issue",
  "Create a new Linear issue, optionally as a sub-issue of a parent.",
  {
    title: z.string().describe("Issue title"),
    description: z.string().describe("Issue description in markdown"),
    teamKey: z.string().describe("Team key, e.g. 'ENG'"),
    parentId: z.string().optional().describe("Parent issue ID to create as sub-issue"),
    labelNames: z.array(z.string()).optional().describe("Label names to apply"),
  },
  async ({ title, description, teamKey, parentId, labelNames }) => {
    const client = getClient();
    const teams = await client.teams({ filter: { key: { eq: teamKey } } });
    const team = teams.nodes[0];
    if (!team) throw new Error(`Team '${teamKey}' not found`);

    let labelIds: string[] | undefined;
    if (labelNames?.length) {
      const labels = await team.labels();
      labelIds = labels.nodes
        .filter((l) => labelNames.some((n) => n.toLowerCase() === l.name.toLowerCase()))
        .map((l) => l.id);
    }

    const result = await client.createIssue({
      title,
      description,
      teamId: team.id,
      parentId,
      labelIds,
    });
    const issue = await result.issue;
    return {
      content: [{ type: "text" as const, text: `Created ${issue?.identifier}: ${issue?.title}` }],
    };
  },
);

/** Query Linear for issues matching a filter. Used by the poller. */
export async function queryIssues(filter: {
  label?: string;
  stateName: string | string[];
}): Promise<Array<{ id: string; identifier: string; title: string; stateName: string; labels: string[]; priority: number }>> {
  const client = getClient();

  const stateNames = Array.isArray(filter.stateName) ? filter.stateName : [filter.stateName];

  const stateFilter =
    stateNames.length === 1
      ? { name: { eqIgnoreCase: stateNames[0] } }
      : { name: { in: stateNames } };

  const issues = await client.issues({
    filter: {
      state: stateFilter,
      ...(filter.label
        ? { labels: { some: { name: { eqIgnoreCase: filter.label } } } }
        : {}),
    },
  });

  const results: Array<{ id: string; identifier: string; title: string; stateName: string; labels: string[]; priority: number }> = [];
  for (const i of issues.nodes) {
    const state = await i.state;
    const issueLabels = await i.labels();
    results.push({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      stateName: state?.name ?? "Unknown",
      labels: issueLabels.nodes.map((l) => l.name.toLowerCase()),
      priority: i.priority,
    });
  }
  // Sort by priority: 1=urgent, 2=high, 3=medium, 4=low, 0=none (treat 0 as lowest)
  results.sort((a, b) => (a.priority || 5) - (b.priority || 5));
  return results;
}

/** Move an issue to a new state by name. Used by the poller. */
export async function moveIssue(
  issueId: string,
  stateName: string,
): Promise<void> {
  const client = getClient();
  const issue = await client.issue(issueId);
  const team = await issue.team;
  if (!team) throw new Error("Issue has no team");

  const states = await team.states();
  const target = states.nodes.find(
    (s) => s.name.toLowerCase() === stateName.toLowerCase(),
  );
  if (!target) throw new Error(`State '${stateName}' not found`);

  await client.updateIssue(issue.id, { stateId: target.id });
}
