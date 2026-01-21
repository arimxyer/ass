// src/enricher.test.ts
import { expect, test, describe, mock, beforeEach, afterEach } from "bun:test";
import { extractGitHubRepo, batchEnrichItems, batchQueryListRepos, validateGitHubName } from "./enricher";
import type { Item, GitHubMetadata } from "./types";

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

describe("validateGitHubName", () => {
  test("accepts valid owner/repo names", () => {
    expect(validateGitHubName("owner")).toBe(true);
    expect(validateGitHubName("my-repo")).toBe(true);
    expect(validateGitHubName("my_repo")).toBe(true);
    expect(validateGitHubName("repo.name")).toBe(true);
    expect(validateGitHubName("123")).toBe(true);
  });

  test("rejects invalid names with special characters", () => {
    expect(validateGitHubName("owner/repo")).toBe(false); // slash not allowed
    expect(validateGitHubName("owner repo")).toBe(false); // space not allowed
    expect(validateGitHubName("")).toBe(false); // empty string
    expect(validateGitHubName("owner\"repo")).toBe(false); // quotes not allowed
    expect(validateGitHubName("owner`repo")).toBe(false); // backticks not allowed
  });
});

describe("batchEnrichItems (live)", () => {
  const hasToken = !!process.env.GITHUB_TOKEN;

  test.skipIf(!hasToken)("adds github metadata to items", async () => {
    const items: Item[] = [
      { name: "Bun", url: "https://github.com/oven-sh/bun", description: "Fast runtime", category: "Runtimes" },
    ];

    const enriched = await batchEnrichItems(items);

    expect(enriched[0].github).toBeDefined();
    const gh = enriched[0].github as GitHubMetadata;
    expect(gh.stars).toBeGreaterThan(0);
    expect(gh.language).toBe("Zig");
  });
});

describe("batchQueryListRepos (live)", () => {
  const hasToken = !!process.env.GITHUB_TOKEN;

  test.skipIf(!hasToken)("returns pushedAt for valid repos", async () => {
    const repos = ["sindresorhus/awesome", "avelino/awesome-go"];
    const result = await batchQueryListRepos(repos);

    expect(result.size).toBe(2);
    expect(result.get("sindresorhus/awesome")?.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.get("avelino/awesome-go")?.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test.skipIf(!hasToken)("returns null for non-existent repos", async () => {
    const repos = ["this-org-does-not-exist-12345/fake-repo"];
    const result = await batchQueryListRepos(repos);

    expect(result.get("this-org-does-not-exist-12345/fake-repo")).toBeNull();
  });
});

describe("batchEnrichItems (mocked)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Set a fake token for mocked tests
    process.env.GITHUB_TOKEN = "fake-token-for-mocked-tests";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Clear the fake token if it was set by us
    if (process.env.GITHUB_TOKEN === "fake-token-for-mocked-tests") {
      delete process.env.GITHUB_TOKEN;
    }
  });

  test("returns items unchanged when no GITHUB_TOKEN", async () => {
    delete process.env.GITHUB_TOKEN;
    const items: Item[] = [
      { name: "Test", url: "https://github.com/owner/repo", description: "Test item", category: "Test" },
    ];

    const enriched = await batchEnrichItems(items);

    expect(enriched).toEqual(items);
    expect(enriched[0].github).toBeUndefined();
  });

  test("enriches items with successful GraphQL response", async () => {
    const mockResponse = {
      data: {
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2024-01-01T00:00:00Z" },
        repo0: {
          stargazerCount: 1234,
          primaryLanguage: { name: "TypeScript" },
          pushedAt: "2024-01-15T10:00:00Z",
        },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    );

    const items: Item[] = [
      { name: "Test Repo", url: "https://github.com/owner/repo", description: "A test repo", category: "Testing" },
    ];

    const enriched = await batchEnrichItems(items);

    expect(enriched[0].github).toBeDefined();
    const gh = enriched[0].github as GitHubMetadata;
    expect(gh.stars).toBe(1234);
    expect(gh.language).toBe("TypeScript");
    expect(gh.pushedAt).toBe("2024-01-15T10:00:00Z");
    expect(enriched[0].lastEnriched).toBeDefined();
  });

  test("handles partial GraphQL response with some repos not found", async () => {
    const mockResponse = {
      data: {
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2024-01-01T00:00:00Z" },
        repo0: {
          stargazerCount: 100,
          primaryLanguage: { name: "JavaScript" },
          pushedAt: "2024-01-10T00:00:00Z",
        },
        repo1: null, // This repo doesn't exist
      },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["repo1"],
          message: "Could not resolve to a Repository",
        },
      ],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    );

    const items: Item[] = [
      { name: "Exists", url: "https://github.com/owner/exists", description: "Exists", category: "Test" },
      { name: "Gone", url: "https://github.com/owner/gone", description: "Gone", category: "Test" },
    ];

    const enriched = await batchEnrichItems(items);

    // First item should be enriched normally
    expect(enriched[0].github).toBeDefined();
    const gh0 = enriched[0].github as GitHubMetadata;
    expect(gh0.stars).toBe(100);

    // Second item should be marked as not found
    expect(enriched[1].github).toBeDefined();
    expect((enriched[1].github as any).notFound).toBe(true);
    expect((enriched[1].github as any).checkedAt).toBeDefined();
  });

  test("handles complete GraphQL failure", async () => {
    const mockResponse = {
      errors: [{ message: "Bad credentials" }],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    );

    const items: Item[] = [
      { name: "Test", url: "https://github.com/owner/repo", description: "Test", category: "Test" },
    ];

    const enriched = await batchEnrichItems(items);

    // Items should be returned but not enriched due to error
    expect(enriched[0].github).toBeUndefined();
  });

  test("handles HTTP error response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))
    );

    const items: Item[] = [
      { name: "Test", url: "https://github.com/owner/repo", description: "Test", category: "Test" },
    ];

    const enriched = await batchEnrichItems(items);

    // Items should be returned but not enriched due to HTTP error
    expect(enriched[0].github).toBeUndefined();
  });

  test("handles network timeout", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("The operation was aborted due to timeout"))
    );

    const items: Item[] = [
      { name: "Test", url: "https://github.com/owner/repo", description: "Test", category: "Test" },
    ];

    const enriched = await batchEnrichItems(items);

    // Items should be returned but not enriched due to timeout
    expect(enriched[0].github).toBeUndefined();
  });

  test("skips non-GitHub URLs", async () => {
    const mockResponse = {
      data: {
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2024-01-01T00:00:00Z" },
        repo0: {
          stargazerCount: 500,
          primaryLanguage: { name: "Rust" },
          pushedAt: "2024-01-20T00:00:00Z",
        },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    );

    const items: Item[] = [
      { name: "GitHub Item", url: "https://github.com/owner/repo", description: "GitHub", category: "Test" },
      { name: "External", url: "https://example.com/tool", description: "External", category: "Test" },
    ];

    const enriched = await batchEnrichItems(items);

    // GitHub item should be enriched
    expect(enriched[0].github).toBeDefined();
    const gh = enriched[0].github as GitHubMetadata;
    expect(gh.stars).toBe(500);

    // External URL should not have github metadata
    expect(enriched[1].github).toBeUndefined();
  });

  test("handles repo with no primary language", async () => {
    const mockResponse = {
      data: {
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2024-01-01T00:00:00Z" },
        repo0: {
          stargazerCount: 50,
          primaryLanguage: null,
          pushedAt: "2024-01-05T00:00:00Z",
        },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    );

    const items: Item[] = [
      { name: "No Lang", url: "https://github.com/owner/nolang", description: "No language", category: "Test" },
    ];

    const enriched = await batchEnrichItems(items);

    expect(enriched[0].github).toBeDefined();
    const gh = enriched[0].github as GitHubMetadata;
    expect(gh.language).toBeNull();
    expect(gh.stars).toBe(50);
  });
});

describe("batchQueryListRepos (mocked)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.GITHUB_TOKEN = "fake-token-for-mocked-tests";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (process.env.GITHUB_TOKEN === "fake-token-for-mocked-tests") {
      delete process.env.GITHUB_TOKEN;
    }
  });

  test("returns empty map when no GITHUB_TOKEN", async () => {
    delete process.env.GITHUB_TOKEN;
    const repos = ["owner/repo"];

    const result = await batchQueryListRepos(repos);

    expect(result.size).toBe(0);
  });

  test("returns pushedAt from successful response", async () => {
    const mockResponse = {
      data: {
        repo0: { pushedAt: "2024-01-20T12:00:00Z" },
        repo1: { pushedAt: "2024-01-19T10:00:00Z" },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    );

    const repos = ["owner/repo1", "owner/repo2"];
    const result = await batchQueryListRepos(repos);

    expect(result.size).toBe(2);
    expect(result.get("owner/repo1")?.pushedAt).toBe("2024-01-20T12:00:00Z");
    expect(result.get("owner/repo2")?.pushedAt).toBe("2024-01-19T10:00:00Z");
  });

  test("marks non-existent repos as null", async () => {
    const mockResponse = {
      data: {
        repo0: { pushedAt: "2024-01-20T12:00:00Z" },
        repo1: null,
      },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["repo1"],
          message: "Could not resolve to a Repository",
        },
      ],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    );

    const repos = ["owner/exists", "owner/gone"];
    const result = await batchQueryListRepos(repos);

    expect(result.get("owner/exists")?.pushedAt).toBe("2024-01-20T12:00:00Z");
    expect(result.get("owner/gone")).toBeNull();
  });

  test("handles HTTP error response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }))
    );

    const repos = ["owner/repo"];
    const result = await batchQueryListRepos(repos);

    expect(result.get("owner/repo")).toBeNull();
  });

  test("handles network error", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network connection failed"))
    );

    const repos = ["owner/repo"];
    const result = await batchQueryListRepos(repos);

    expect(result.get("owner/repo")).toBeNull();
  });
});
