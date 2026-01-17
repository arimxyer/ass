// src/enricher.test.ts
import { expect, test, describe } from "bun:test";
import { extractGitHubRepo, batchEnrichItems } from "./enricher";
import type { Item } from "./types";

describe("extractGitHubRepo", () => {
  test("extracts owner/repo from GitHub URL", () => {
    const result = extractGitHubRepo("https://github.com/owner/repo");
    expect(result).toBe("owner/repo");
  });

  test("handles URLs with paths", () => {
    const result = extractGitHubRepo("https://github.com/owner/repo/tree/main");
    expect(result).toBe("owner/repo");
  });

  test("returns null for non-GitHub URLs", () => {
    const result = extractGitHubRepo("https://example.com/tool");
    expect(result).toBeNull();
  });
});

describe("batchEnrichItems", () => {
  test("adds github metadata to items", async () => {
    const items: Item[] = [
      { name: "Bun", url: "https://github.com/oven-sh/bun", description: "Fast runtime", category: "Runtimes" },
    ];

    // This test requires GITHUB_TOKEN - skip if not available
    if (!process.env.GITHUB_TOKEN) {
      console.log("Skipping enrichment test - no GITHUB_TOKEN");
      return;
    }

    const enriched = await batchEnrichItems(items);

    expect(enriched[0].github).toBeDefined();
    expect(enriched[0].github?.stars).toBeGreaterThan(0);
    expect(enriched[0].github?.language).toBe("Zig");
  });
});
