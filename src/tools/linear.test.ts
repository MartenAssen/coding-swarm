import { describe, it, expect } from "vitest";
import { getIssueDetails, extractInlineImages } from "./linear.js";

function mockClient(overrides: {
  description?: string;
  attachments?: Array<{ title: string; url: string; subtitle?: string | null }>;
  comments?: Array<{ createdAt: Date; body: string }>;
} = {}) {
  const attachments = overrides.attachments ?? [];
  const comments = overrides.comments ?? [];

  return {
    issue: async () => ({
      identifier: "PFX-42",
      title: "Test issue",
      description: overrides.description ?? "Some description",
      priority: 2,
      url: "https://linear.app/test/PFX-42",
      state: Promise.resolve({ name: "In Development" }),
      labels: async () => ({ nodes: [{ name: "agent" }] }),
      comments: async () => ({ nodes: comments }),
      assignee: Promise.resolve({ name: "Marten" }),
      attachments: async () => ({ nodes: attachments }),
    }),
  } as any;
}

describe("getIssueDetails", () => {
  it("includes attachments section when attachments exist", async () => {
    const client = mockClient({
      attachments: [
        { title: "Design doc", url: "https://example.com/doc.pdf", subtitle: "v2" },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const text = result.content[0].text;

    expect(text).toContain("## Attachments");
    expect(text).toContain("[Design doc](https://example.com/doc.pdf) — v2");
  });

  it("omits attachments section when there are none", async () => {
    const client = mockClient({ attachments: [] });

    const result = await getIssueDetails(client, "PFX-42");
    const text = result.content[0].text;

    expect(text).not.toContain("## Attachments");
  });

  it("returns image blocks for image attachments", async () => {
    const client = mockClient({
      attachments: [
        { title: "Screenshot", url: "https://cdn.linear.app/screenshot.png" },
        { title: "Photo", url: "https://cdn.linear.app/photo.JPG" },
        { title: "Doc", url: "https://example.com/doc.pdf" },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(2);
    expect(images[0].source.url).toBe("https://cdn.linear.app/screenshot.png");
    expect(images[1].source.url).toBe("https://cdn.linear.app/photo.JPG");
  });

  it("handles image URLs with query parameters", async () => {
    const client = mockClient({
      attachments: [
        { title: "Upload", url: "https://cdn.linear.app/img.webp?token=abc123" },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(1);
  });

  it("does not return image blocks for non-image files", async () => {
    const client = mockClient({
      attachments: [
        { title: "Spreadsheet", url: "https://example.com/data.xlsx" },
        { title: "PR", url: "https://github.com/org/repo/pull/1" },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(0);
  });

  it("includes subtitle only when present", async () => {
    const client = mockClient({
      attachments: [
        { title: "With sub", url: "https://example.com/a", subtitle: "details" },
        { title: "No sub", url: "https://example.com/b", subtitle: null },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const text = result.content[0].text;

    expect(text).toContain("[With sub](https://example.com/a) — details");
    expect(text).toContain("[No sub](https://example.com/b)");
    expect(text).not.toContain("No sub](https://example.com/b) —");
  });
});

describe("extractInlineImages", () => {
  it("extracts markdown image URLs", () => {
    const md = "Some text ![screenshot](https://uploads.linear.app/img.png) and more";
    expect(extractInlineImages(md)).toEqual(["https://uploads.linear.app/img.png"]);
  });

  it("extracts multiple images", () => {
    const md = "![a](https://example.com/1.png) text ![b](https://example.com/2.jpg)";
    expect(extractInlineImages(md)).toEqual([
      "https://example.com/1.png",
      "https://example.com/2.jpg",
    ]);
  });

  it("returns empty array when no images", () => {
    expect(extractInlineImages("just text")).toEqual([]);
    expect(extractInlineImages("[link](https://example.com)")).toEqual([]);
  });
});

describe("getIssueDetails inline images", () => {
  it("returns image blocks for images in description", async () => {
    const client = mockClient({
      description: "Bug here:\n![screenshot](https://uploads.linear.app/abc/img.png)\nSee above",
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(1);
    expect(images[0].source.url).toBe("https://uploads.linear.app/abc/img.png");
  });

  it("returns image blocks for images in comments", async () => {
    const client = mockClient({
      comments: [
        { createdAt: new Date(), body: "Look at this ![error](https://uploads.linear.app/error.jpg)" },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(1);
    expect(images[0].source.url).toBe("https://uploads.linear.app/error.jpg");
  });

  it("deduplicates images across description, comments, and attachments", async () => {
    const url = "https://uploads.linear.app/same.png";
    const client = mockClient({
      description: `![img](${url})`,
      comments: [
        { createdAt: new Date(), body: `See ![img](${url})` },
      ],
      attachments: [
        { title: "Same", url },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(1);
  });

  it("combines images from all sources", async () => {
    const client = mockClient({
      description: "![desc](https://uploads.linear.app/desc.png)",
      comments: [
        { createdAt: new Date(), body: "![comment](https://uploads.linear.app/comment.jpg)" },
      ],
      attachments: [
        { title: "Attached", url: "https://cdn.linear.app/attached.webp" },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(3);
  });
});
