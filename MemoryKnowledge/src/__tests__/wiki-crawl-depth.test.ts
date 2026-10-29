import { describe, expect, it, vi } from "vitest";
import { createWikiSourceRoutes } from "../wiki-source/routes.js";
import type { WikiSourceRegistry } from "../wiki-source/registry.js";
import type { ICredentialStore } from "../source-auth/types.js";
import type { WikiServiceLike } from "../wiki-source/import-runner.js";
import {
  DEFAULT_LINKS_MAX_DEPTH,
  MAX_LINKS_CRAWL_DEPTH,
  MAX_LINKS_CRAWL_PAGES,
  resolveLinksMaxDepth,
} from "../wiki-source/types.js";

const mcp = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  getDocument: vi.fn(),
}));

vi.mock("../wiki-source/providers/iwiki/mcp-client.js", () => ({
  ...mcp,
  getSpaceRoot: vi.fn(),
}));

const { crawlLinks } = await import("../wiki-source/providers/iwiki/crawlers/links.js");

describe("Wiki links crawl depth", () => {
  it("uses the documented default", () => {
    expect(resolveLinksMaxDepth()).toBe(DEFAULT_LINKS_MAX_DEPTH);
  });

  it("preserves bounded caller values", () => {
    expect(resolveLinksMaxDepth(1)).toBe(1);
    expect(resolveLinksMaxDepth(5)).toBe(5);
  });

  it("clamps programmatic callers to the maximum", () => {
    expect(resolveLinksMaxDepth(Number.MAX_SAFE_INTEGER)).toBe(MAX_LINKS_CRAWL_DEPTH);
    expect(resolveLinksMaxDepth(-1)).toBe(1);
  });

  it("rejects oversized request-body depth before provider access", async () => {
    const app = createWikiSourceRoutes({
      registry: {} as WikiSourceRegistry,
      credentialStore: {} as ICredentialStore,
      wikiService: {} as WikiServiceLike,
    });

    const response = await app.request("/list", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": "svc",
        "x-tdai-team-id": "team",
        "x-tdai-user-id": "user",
      },
      body: JSON.stringify({
        wiki_id: "wiki",
        source_url: "https://example.test/p/1",
        provider_id: "iwiki",
        crawl: { mode: "links", maxDepth: MAX_LINKS_CRAWL_DEPTH + 1 },
      }),
    });

    expect(await response.text()).toContain(
      `crawl.maxDepth must be an integer between 1 and ${MAX_LINKS_CRAWL_DEPTH}`,
    );
  });

  it("caps high-fanout links traversal by page count", async () => {
    const links = Array.from(
      { length: MAX_LINKS_CRAWL_PAGES + 100 },
      (_, index) => `[Page ${index}](https://example.test/p/${index})`,
    ).join("\n");
    mcp.getMetadata.mockResolvedValue({ title: "Page" });
    mcp.getDocument.mockResolvedValue({ markdown: links });

    const pages = await crawlLinks(
      { secret: "token", endpoint: "https://example.test" },
      ["root"],
      1,
    );

    expect(pages).toHaveLength(MAX_LINKS_CRAWL_PAGES);
    expect(mcp.getDocument).toHaveBeenCalledTimes(MAX_LINKS_CRAWL_PAGES);
    expect(mcp.getMetadata).toHaveBeenCalledTimes(MAX_LINKS_CRAWL_PAGES);
  });
});
