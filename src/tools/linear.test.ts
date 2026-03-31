import { describe, it, expect, vi, beforeEach } from "vitest";
import { getIssueDetails, extractInlineImages } from "./linear.js";

// Mock global fetch to return fake image data for image URLs
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp",
    };
    const mime = mimeMap[ext];
    if (!mime) {
      return { ok: false } as Response;
    }
    return {
      ok: true,
      headers: new Headers({ "content-type": mime }),
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Response;
  }));
});

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
    const textBlock = result.content.find((b: any) => b.type === "text") as any;

    expect(textBlock.text).toContain("## Attachments");
    expect(textBlock.text).toContain("[Design doc](https://example.com/doc.pdf) — v2");
  });

  it("omits attachments section when there are none", async () => {
    const client = mockClient({ attachments: [] });

    const result = await getIssueDetails(client, "PFX-42");
    const textBlock = result.content.find((b: any) => b.type === "text") as any;

    expect(textBlock.text).not.toContain("## Attachments");
  });

  it("returns base64 image blocks for image attachments", async () => {
    const client = mockClient({
      attachments: [
        { title: "Screenshot", url: "https://cdn.linear.app/screenshot.png" },
        { title: "Photo", url: "https://cdn.linear.app/photo.jpg" },
        { title: "Doc", url: "https://example.com/doc.pdf" },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(2);
    expect((images[0] as any).mimeType).toBe("image/png");
    expect((images[0] as any).data).toBeDefined();
    expect((images[1] as any).mimeType).toBe("image/jpeg");
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
    expect((images[0] as any).mimeType).toBe("image/webp");
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
    const textBlock = result.content.find((b: any) => b.type === "text") as any;

    expect(textBlock.text).toContain("[With sub](https://example.com/a) — details");
    expect(textBlock.text).toContain("[No sub](https://example.com/b)");
    expect(textBlock.text).not.toContain("No sub](https://example.com/b) —");
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
  it("returns base64 image blocks for images in description", async () => {
    const client = mockClient({
      description: "Bug here:\n![screenshot](https://uploads.linear.app/abc/img.png)\nSee above",
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(1);
    expect((images[0] as any).mimeType).toBe("image/png");
    expect((images[0] as any).data).toBeDefined();
  });

  it("returns base64 image blocks for images in comments", async () => {
    const client = mockClient({
      comments: [
        { createdAt: new Date(), body: "Look at this ![error](https://uploads.linear.app/error.jpg)" },
      ],
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(1);
    expect((images[0] as any).mimeType).toBe("image/jpeg");
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

  it("skips images that fail to fetch", async () => {
    // Override fetch to fail for one URL
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("broken")) return { ok: false } as Response;
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
    }));

    const client = mockClient({
      description: "![ok](https://uploads.linear.app/ok.png) ![broken](https://uploads.linear.app/broken.png)",
    });

    const result = await getIssueDetails(client, "PFX-42");
    const images = result.content.filter((b: any) => b.type === "image");

    expect(images).toHaveLength(1);
  });
});
