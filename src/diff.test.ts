import { describe, it, expect } from "bun:test";
import { diffItems } from "./diff";
import type { Item } from "./types";

describe("diffItems", () => {
  const makeItem = (url: string, name = "Test", desc = "Desc"): Item => ({
    name,
    url,
    description: desc,
    category: "Test",
  });

  it("detects added items", () => {
    const oldItems: Item[] = [makeItem("https://a.com")];
    const newItems: Item[] = [makeItem("https://a.com"), makeItem("https://b.com")];

    const result = diffItems(oldItems, newItems);

    expect(result.added).toHaveLength(1);
    expect(result.added[0].url).toBe("https://b.com");
    expect(result.removed).toHaveLength(0);
    expect(result.unchanged).toHaveLength(1);
  });

  it("detects removed items", () => {
    const oldItems: Item[] = [makeItem("https://a.com"), makeItem("https://b.com")];
    const newItems: Item[] = [makeItem("https://a.com")];

    const result = diffItems(oldItems, newItems);

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].url).toBe("https://b.com");
    expect(result.added).toHaveLength(0);
  });

  it("detects updated items (same URL, different metadata)", () => {
    const oldItems: Item[] = [makeItem("https://a.com", "Old Name", "Old Desc")];
    const newItems: Item[] = [makeItem("https://a.com", "New Name", "New Desc")];

    const result = diffItems(oldItems, newItems);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].name).toBe("New Name");
    expect(result.unchanged).toHaveLength(0);
  });

  it("preserves github data on unchanged items", () => {
    const oldItems: Item[] = [{
      ...makeItem("https://github.com/foo/bar"),
      github: { stars: 100, language: "TypeScript", pushedAt: "2026-01-01T00:00:00Z" },
      lastEnriched: "2026-01-01T00:00:00Z",
    }];
    const newItems: Item[] = [makeItem("https://github.com/foo/bar")];

    const result = diffItems(oldItems, newItems);

    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0].github?.stars).toBe(100);
    expect(result.unchanged[0].lastEnriched).toBe("2026-01-01T00:00:00Z");
  });

  it("preserves github data on updated items", () => {
    const oldItems: Item[] = [{
      ...makeItem("https://github.com/foo/bar", "Old"),
      github: { stars: 100, language: "TypeScript", pushedAt: "2026-01-01T00:00:00Z" },
      lastEnriched: "2026-01-01T00:00:00Z",
    }];
    const newItems: Item[] = [makeItem("https://github.com/foo/bar", "New")];

    const result = diffItems(oldItems, newItems);

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].name).toBe("New");
    expect(result.updated[0].github?.stars).toBe(100);
  });
});
