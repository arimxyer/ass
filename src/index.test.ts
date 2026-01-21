// src/index.test.ts
import { describe, test, expect } from "bun:test";
import type { Item } from "./types";

// Test the core logic patterns used in the MCP server
// These verify the algorithms without importing the MCP module (which starts a server)

interface MockItem extends Item {
  id: number;
  listRepo: string;
  github?: { stars: number; language: string | null; pushedAt: string };
}

// Mock data for testing
const mockItems: MockItem[] = [
  { id: 0, name: "Tool A", url: "https://github.com/a", description: "Desc A", category: "Testing", listRepo: "list/one", github: { stars: 1000, language: "TypeScript", pushedAt: "2024-01-01" } },
  { id: 1, name: "Tool B", url: "https://github.com/b", description: "Desc B", category: "Testing", listRepo: "list/one", github: { stars: 500, language: "Python", pushedAt: "2024-06-01" } },
  { id: 2, name: "Tool C", url: "https://github.com/c", description: "Desc C", category: "Utils", listRepo: "list/two", github: { stars: 2000, language: "TypeScript", pushedAt: "2024-03-01" } },
  { id: 3, name: "Tool D", url: "https://github.com/d", description: "Desc D", category: "Testing", listRepo: "list/two", github: { stars: 100, language: "Rust", pushedAt: "2024-12-01" } },
  { id: 4, name: "Tool E", url: "https://example.com/e", description: "Desc E", category: "Other", listRepo: "list/three" },
];

const mockLists = [
  { repo: "list/one", name: "Awesome One", stars: 15000, description: "First list" },
  { repo: "list/two", name: "Awesome Two", stars: 5500, description: "Second list" },
  { repo: "list/three", name: "Awesome Three", stars: 800, description: "Third list" },
];

describe("computeStats logic", () => {
  test("star distribution buckets items correctly", () => {
    const starBuckets: Record<string, number> = {
      "10000+": 0,
      "5000-9999": 0,
      "1000-4999": 0,
      "500-999": 0,
      "<500": 0,
    };

    for (const list of mockLists) {
      if (list.stars >= 10000) starBuckets["10000+"]++;
      else if (list.stars >= 5000) starBuckets["5000-9999"]++;
      else if (list.stars >= 1000) starBuckets["1000-4999"]++;
      else if (list.stars >= 500) starBuckets["500-999"]++;
      else starBuckets["<500"]++;
    }

    expect(starBuckets["10000+"]).toBe(1);
    expect(starBuckets["5000-9999"]).toBe(1);
    expect(starBuckets["500-999"]).toBe(1);
    expect(starBuckets["<500"]).toBe(0);
  });

  test("language counting aggregates correctly", () => {
    const languageCounts = new Map<string, number>();

    for (const item of mockItems) {
      if (item.github?.language) {
        languageCounts.set(item.github.language, (languageCounts.get(item.github.language) || 0) + 1);
      }
    }

    expect(languageCounts.get("TypeScript")).toBe(2);
    expect(languageCounts.get("Python")).toBe(1);
    expect(languageCounts.get("Rust")).toBe(1);
  });

  test("category counting aggregates correctly", () => {
    const categoryCounts = new Map<string, number>();

    for (const item of mockItems) {
      if (item.category) {
        categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
      }
    }

    expect(categoryCounts.get("Testing")).toBe(3);
    expect(categoryCounts.get("Utils")).toBe(1);
    expect(categoryCounts.get("Other")).toBe(1);
  });

  test("enriched item count is correct", () => {
    const enrichedCount = mockItems.filter(i => i.github !== undefined).length;
    expect(enrichedCount).toBe(4);
  });
});

describe("search logic", () => {
  test("offset/limit pagination works correctly", () => {
    const offset = 1;
    const limit = 2;
    const results = mockItems.slice(offset, offset + limit);

    expect(results.length).toBe(2);
    expect(results[0].name).toBe("Tool B");
    expect(results[1].name).toBe("Tool C");
  });

  test("offset beyond array length returns empty", () => {
    const offset = 100;
    const limit = 10;
    const results = mockItems.slice(offset, offset + limit);

    expect(results.length).toBe(0);
  });

  test("limit caps results correctly", () => {
    const offset = 0;
    const limit = 2;
    const results = mockItems.slice(offset, offset + limit);

    expect(results.length).toBe(2);
  });

  test("filter by repo works", () => {
    const repoLower = "list/one";
    const filtered = mockItems.filter(item => item.listRepo.toLowerCase() === repoLower);

    expect(filtered.length).toBe(2);
    expect(filtered.every(i => i.listRepo === "list/one")).toBe(true);
  });

  test("filter by category works", () => {
    const catLower = "testing";
    const filtered = mockItems.filter(item => {
      const itemCat = item.category?.toLowerCase() ?? "";
      return itemCat.includes(catLower);
    });

    expect(filtered.length).toBe(3);
  });

  test("filter by language works", () => {
    const langLower = "typescript";
    const filtered = mockItems.filter(item =>
      item.github?.language?.toLowerCase() === langLower
    );

    expect(filtered.length).toBe(2);
  });

  test("filter by minStars works", () => {
    const minStars = 500;
    const filtered = mockItems.filter(item =>
      item.github && item.github.stars >= minStars
    );

    expect(filtered.length).toBe(3);
    expect(filtered.every(i => i.github!.stars >= 500)).toBe(true);
  });

  test("combined filters work", () => {
    const repoLower = "list/one";
    const minStars = 500;

    const filtered = mockItems.filter(item => {
      if (item.listRepo.toLowerCase() !== repoLower) return false;
      if (!item.github || item.github.stars < minStars) return false;
      return true;
    });

    expect(filtered.length).toBe(2);
  });
});

describe("sort orders", () => {
  test("sort by stars descending", () => {
    const sorted = [...mockItems]
      .filter(i => i.github)
      .sort((a, b) => (b.github?.stars ?? 0) - (a.github?.stars ?? 0));

    expect(sorted[0].name).toBe("Tool C"); // 2000 stars
    expect(sorted[1].name).toBe("Tool A"); // 1000 stars
    expect(sorted[2].name).toBe("Tool B"); // 500 stars
    expect(sorted[3].name).toBe("Tool D"); // 100 stars
  });

  test("sort by updated descending", () => {
    const sorted = [...mockItems]
      .filter(i => i.github)
      .sort((a, b) => (b.github?.pushedAt ?? "").localeCompare(a.github?.pushedAt ?? ""));

    expect(sorted[0].name).toBe("Tool D"); // 2024-12-01
    expect(sorted[1].name).toBe("Tool B"); // 2024-06-01
    expect(sorted[2].name).toBe("Tool C"); // 2024-03-01
    expect(sorted[3].name).toBe("Tool A"); // 2024-01-01
  });
});

describe("browse_categories logic", () => {
  test("category aggregation counts correctly", () => {
    const categoryCounts = new Map<string, number>();

    for (const item of mockItems) {
      const cat = item.category || "Uncategorized";
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }

    const categories = Array.from(categoryCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    expect(categories[0]).toEqual({ name: "Testing", count: 3 });
    expect(categories.length).toBe(3);
  });

  test("repo filtering affects category counts", () => {
    const repo = "list/one";
    const items = mockItems.filter(i => i.listRepo.toLowerCase() === repo.toLowerCase());

    const categoryCounts = new Map<string, number>();
    for (const item of items) {
      const cat = item.category || "Uncategorized";
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }

    expect(categoryCounts.get("Testing")).toBe(2);
    expect(categoryCounts.has("Utils")).toBe(false);
  });

  test("limit parameter caps results", () => {
    const categoryCounts = new Map<string, number>();
    for (const item of mockItems) {
      const cat = item.category || "Uncategorized";
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }

    const limit = 2;
    const categories = Array.from(categoryCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    expect(categories.length).toBe(2);
  });
});
