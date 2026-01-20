// src/enricher.test.ts
import { expect, test, describe } from "bun:test";
import { extractGitHubRepo, batchEnrichItems, batchQueryListRepos } from "./enricher";
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

describe("batchQueryListRepos", () => {
  test("returns pushedAt for valid repos", async () => {
    if (!process.env.GITHUB_TOKEN) {
      console.log("Skipping batchQueryListRepos test - no GITHUB_TOKEN");
      return;
    }

    const repos = ["sindresorhus/awesome", "avelino/awesome-go"];
    const result = await batchQueryListRepos(repos);

    expect(result.size).toBe(2);
    expect(result.get("sindresorhus/awesome")?.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.get("avelino/awesome-go")?.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("returns null for non-existent repos", async () => {
    if (!process.env.GITHUB_TOKEN) {
      console.log("Skipping batchQueryListRepos test - no GITHUB_TOKEN");
      return;
    }

    const repos = ["this-org-does-not-exist-12345/fake-repo"];
    const result = await batchQueryListRepos(repos);

    expect(result.get("this-org-does-not-exist-12345/fake-repo")).toBeNull();
  });
});
