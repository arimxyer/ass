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
});
