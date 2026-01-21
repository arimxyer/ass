// src/parser.test.ts
import { expect, test, describe } from "bun:test";
import { parseReadme } from "./parser";

const sampleReadme = `
# Awesome Test

## Category One

_Description of category._

- [Tool A](https://github.com/org/tool-a) - A great tool for testing.
- [Tool B](https://example.com/tool-b) - Another useful tool.

## Category Two

### Subcategory

- [Tool C](https://github.com/org/tool-c) - Third tool.
`;

describe("parseReadme", () => {
  test("extracts items with categories", () => {
    const items = parseReadme(sampleReadme);

    expect(items.length).toBe(3);
    expect(items[0].name).toBe("Tool A");
    expect(items[0].url).toBe("https://github.com/org/tool-a");
    expect(items[0].description).toBe("A great tool for testing.");
    expect(items[0].category).toBe("Category One");
  });

  test("handles subcategories", () => {
    const items = parseReadme(sampleReadme);
    const toolC = items.find(i => i.name === "Tool C");

    expect(toolC?.category).toBe("Category Two");
    expect(toolC?.subcategory).toBe("Subcategory");
  });

  test("skips anchor links", () => {
    const items = parseReadme(sampleReadme);
    const hasAnchor = items.some(i => i.url.startsWith("#"));

    expect(hasAnchor).toBe(false);
  });

  test("rejects dangerous URL schemes", () => {
    const readmeWithDangerousUrls = `
# Awesome Test

## Tools

- [Safe Tool](https://example.com/safe) - A safe tool.
- [XSS Tool](javascript:alert('xss')) - This should be rejected.
- [Data Tool](data:text/html,<script>evil()</script>) - This should be rejected.
- [FTP Tool](ftp://example.com/file) - This should be rejected.
- [Another Safe](http://example.com/also-safe) - HTTP is allowed.
`;

    const items = parseReadme(readmeWithDangerousUrls);

    expect(items.length).toBe(2);
    expect(items.map(i => i.name)).toEqual(["Safe Tool", "Another Safe"]);
    expect(items.every(i => i.url.startsWith("http://") || i.url.startsWith("https://"))).toBe(true);
  });

  test("captures items before first h2 as Uncategorized", () => {
    const readmeWithEarlyItems = `
# Awesome Test

Some intro text.

- [Early Tool](https://example.com/early) - This appears before any h2.

## Category One

- [Regular Tool](https://github.com/org/tool) - After h2.
`;

    const items = parseReadme(readmeWithEarlyItems);

    expect(items.length).toBe(2);

    const earlyTool = items.find(i => i.name === "Early Tool");
    expect(earlyTool).toBeDefined();
    expect(earlyTool?.category).toBe("Uncategorized");
    expect(earlyTool?.url).toBe("https://example.com/early");
    expect(earlyTool?.description).toBe("This appears before any h2.");
    expect(earlyTool?.subcategory).toBeUndefined();

    const regularTool = items.find(i => i.name === "Regular Tool");
    expect(regularTool?.category).toBe("Category One");
  });
});

describe("parseReadme edge cases", () => {
  test("handles empty input", () => {
    expect(parseReadme("")).toEqual([]);
  });

  test("handles input with no h2 headers", () => {
    const md = "# Title\n\n- [Link](https://example.com) - Description";
    const items = parseReadme(md);
    expect(items[0].category).toBe("Uncategorized");
  });

  test("handles malformed links gracefully", () => {
    const md = "## Category\n\n- [Incomplete](";
    expect(() => parseReadme(md)).not.toThrow();
  });

  test("handles nested lists", () => {
    const md = "## Category\n\n- Parent\n  - [Nested](https://example.com) - Desc";
    const items = parseReadme(md);
    expect(items.length).toBeGreaterThan(0);
  });

  test("handles unicode in names and descriptions", () => {
    const md = "## Category\n\n- [日本語](https://example.com) - 説明文";
    const items = parseReadme(md);
    expect(items[0].name).toBe("日本語");
  });
});
