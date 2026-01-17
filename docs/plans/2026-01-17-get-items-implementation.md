# get_items Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `get_items` MCP tool that retrieves enriched resources from awesome lists using pre-indexed data.

**Architecture:** Build-time indexer parses all 631 list READMEs using mdast, enriches with GitHub metadata via GraphQL, outputs `data/items.json`. MCP server loads this at startup for instant lookups.

**Tech Stack:** Bun, mdast-util-from-markdown, octokit, zod

---

## Task 1: Add Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install required packages**

```bash
bun add octokit mdast-util-from-markdown
```

**Step 2: Verify installation**

```bash
bun run -e "import { Octokit } from 'octokit'; import { fromMarkdown } from 'mdast-util-from-markdown'; console.log('OK')"
```

Expected: `OK`

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add octokit and mdast-util-from-markdown dependencies"
```

---

## Task 2: Create Item Types

**Files:**
- Create: `src/types.ts`

**Step 1: Create types file**

```typescript
// src/types.ts

export interface Item {
  name: string;
  url: string;
  description: string;
  category: string;
  subcategory?: string;
  lastEnriched?: string;
  github?: {
    stars: number;
    language: string | null;
    pushedAt: string;
  };
}

export interface ListEntry {
  lastParsed: string;
  pushedAt: string;
  items: Item[];
}

export interface ItemsIndex {
  generatedAt: string;
  listCount: number;
  itemCount: number;
  lists: Record<string, ListEntry>;
}
```

**Step 2: Verify types compile**

```bash
bun run -e "import { Item, ListEntry, ItemsIndex } from './src/types'; console.log('Types OK')"
```

Expected: `Types OK`

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add item and index type definitions"
```

---

## Task 3: Create README Parser

**Files:**
- Create: `src/parser.ts`
- Create: `src/parser.test.ts`

**Step 1: Write failing test**

```typescript
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
```

**Step 2: Run test to verify it fails**

```bash
bun test src/parser.test.ts
```

Expected: FAIL with "Cannot find module"

**Step 3: Write implementation**

```typescript
// src/parser.ts
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Item } from "./types";

export function parseReadme(markdown: string): Item[] {
  const tree = fromMarkdown(markdown);
  const items: Item[] = [];
  let currentCategory = "";
  let currentSubcategory = "";

  function walk(node: any) {
    // Track h2 headings as categories
    if (node.type === "heading" && node.depth === 2) {
      const text = node.children?.find((c: any) => c.type === "text")?.value || "";
      currentCategory = text;
      currentSubcategory = "";
    }

    // Track h3 headings as subcategories
    if (node.type === "heading" && node.depth === 3) {
      const text = node.children?.find((c: any) => c.type === "text")?.value || "";
      currentSubcategory = text;
    }

    // Extract list items with links
    if (node.type === "listItem" && currentCategory) {
      const paragraph = node.children?.find((c: any) => c.type === "paragraph");
      if (paragraph) {
        const link = paragraph.children?.find((c: any) => c.type === "link");
        if (link) {
          const name = link.children?.find((c: any) => c.type === "text")?.value || "";
          const url = link.url || "";

          // Get description (text after the link)
          const linkIndex = paragraph.children.indexOf(link);
          const afterLink = paragraph.children.slice(linkIndex + 1);
          const description = afterLink
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.value)
            .join("")
            .replace(/^\s*[-–—]\s*/, "")
            .trim();

          // Skip anchor links and empty names
          if (name && url && !url.startsWith("#")) {
            items.push({
              name,
              url,
              description,
              category: currentCategory,
              ...(currentSubcategory && { subcategory: currentSubcategory }),
            });
          }
        }
      }
    }

    // Recurse into children
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(tree);
  return items;
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/parser.test.ts
```

Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/parser.ts src/parser.test.ts
git commit -m "feat: add README parser with mdast"
```

---

## Task 4: Create GitHub Enricher

**Files:**
- Create: `src/enricher.ts`
- Create: `src/enricher.test.ts`

**Step 1: Write failing test**

```typescript
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
```

**Step 2: Run test to verify it fails**

```bash
bun test src/enricher.test.ts
```

Expected: FAIL with "Cannot find module"

**Step 3: Write implementation**

```typescript
// src/enricher.ts
import { Octokit } from "octokit";
import type { Item } from "./types";

export function extractGitHubRepo(url: string): string | null {
  const match = url.match(/github\.com\/([^\/]+\/[^\/]+)/);
  return match ? match[1].replace(/\.git$/, "") : null;
}

export async function batchEnrichItems(items: Item[]): Promise<Item[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("No GITHUB_TOKEN - skipping enrichment");
    return items;
  }

  const octokit = new Octokit({ auth: token });

  // Extract unique GitHub repos
  const repoMap = new Map<string, Item[]>();
  for (const item of items) {
    const repo = extractGitHubRepo(item.url);
    if (repo) {
      if (!repoMap.has(repo)) repoMap.set(repo, []);
      repoMap.get(repo)!.push(item);
    }
  }

  const repos = Array.from(repoMap.keys());
  console.log(`Enriching ${repos.length} unique repos...`);

  // Batch query using GraphQL (100 at a time)
  const batchSize = 100;
  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);

    const query = `
      query {
        ${batch.map((repo, idx) => {
          const [owner, name] = repo.split("/");
          return `repo${idx}: repository(owner: "${owner}", name: "${name}") {
            stargazerCount
            primaryLanguage { name }
            pushedAt
          }`;
        }).join("\n")}
      }
    `;

    try {
      const result: any = await octokit.graphql(query);

      for (let j = 0; j < batch.length; j++) {
        const data = result[`repo${j}`];
        if (data) {
          const itemsForRepo = repoMap.get(batch[j])!;
          for (const item of itemsForRepo) {
            item.github = {
              stars: data.stargazerCount,
              language: data.primaryLanguage?.name || null,
              pushedAt: data.pushedAt,
            };
            item.lastEnriched = new Date().toISOString();
          }
        }
      }
    } catch (error: any) {
      console.error(`Error enriching batch ${i}-${i + batchSize}:`, error.message);
    }
  }

  return items;
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/enricher.test.ts
```

Expected: PASS (3 tests, enrichment test may skip without token)

**Step 5: Commit**

```bash
git add src/enricher.ts src/enricher.test.ts
git commit -m "feat: add GitHub enricher with GraphQL batching"
```

---

## Task 5: Create Build Script

**Files:**
- Create: `scripts/build-items.ts`

**Step 1: Create build script**

```typescript
// scripts/build-items.ts
import { parseReadme } from "../src/parser";
import { batchEnrichItems } from "../src/enricher";
import type { ItemsIndex, ListEntry, Item } from "../src/types";

// Load list of awesome lists
const listsPath = new URL("../data/lists.json", import.meta.url);
const lists: { repo: string; name: string; stars: number }[] = await Bun.file(listsPath).json();

console.log(`Building items index for ${lists.length} lists...`);

const index: ItemsIndex = {
  generatedAt: new Date().toISOString(),
  listCount: 0,
  itemCount: 0,
  lists: {},
};

// Fetch and parse each README
let allItems: (Item & { sourceList: string })[] = [];

for (let i = 0; i < lists.length; i++) {
  const list = lists[i];
  const progress = `[${i + 1}/${lists.length}]`;

  try {
    // Try main branch first, then master
    let readme: string | null = null;
    for (const branch of ["main", "master"]) {
      const url = `https://raw.githubusercontent.com/${list.repo}/${branch}/README.md`;
      const res = await fetch(url);
      if (res.ok) {
        readme = await res.text();
        break;
      }
    }

    if (!readme) {
      console.log(`${progress} ${list.repo} - README not found, skipping`);
      continue;
    }

    const items = parseReadme(readme);
    console.log(`${progress} ${list.repo} - ${items.length} items`);

    // Store in index
    index.lists[list.repo] = {
      lastParsed: new Date().toISOString(),
      pushedAt: "", // Will be filled by enrichment
      items,
    };

    // Collect for enrichment
    for (const item of items) {
      allItems.push({ ...item, sourceList: list.repo });
    }

    index.listCount++;
  } catch (error: any) {
    console.error(`${progress} ${list.repo} - Error: ${error.message}`);
  }
}

console.log(`\nParsed ${allItems.length} items from ${index.listCount} lists`);

// Enrich with GitHub metadata
console.log("\nEnriching with GitHub metadata...");
const enriched = await batchEnrichItems(allItems);

// Update index with enriched items
for (const item of enriched) {
  const sourceList = (item as any).sourceList;
  const listEntry = index.lists[sourceList];
  if (listEntry) {
    const idx = listEntry.items.findIndex(i => i.url === item.url);
    if (idx >= 0) {
      listEntry.items[idx] = item;
    }
  }
}

// Count total items
index.itemCount = Object.values(index.lists).reduce((sum, l) => sum + l.items.length, 0);

// Write output
const outputPath = new URL("../data/items.json", import.meta.url);
await Bun.write(outputPath, JSON.stringify(index, null, 2));

console.log(`\nWrote ${index.itemCount} items to data/items.json`);
```

**Step 2: Test with a small subset**

```bash
# Create a test lists file with just 3 repos
echo '[{"repo":"sindresorhus/awesome","name":"Awesome","stars":300000},{"repo":"vinta/awesome-python","name":"Awesome Python","stars":200000},{"repo":"rust-unofficial/awesome-rust","name":"Awesome Rust","stars":40000}]' > /tmp/test-lists.json

# Run build with test data (temporarily swap files)
cp data/lists.json data/lists.json.bak
cp /tmp/test-lists.json data/lists.json
GITHUB_TOKEN=${GITHUB_TOKEN:-} bun run scripts/build-items.ts
mv data/lists.json.bak data/lists.json
```

Expected: Output showing items parsed and written

**Step 3: Verify output**

```bash
cat data/items.json | head -50
```

Expected: JSON with generatedAt, listCount, itemCount, lists object

**Step 4: Commit**

```bash
git add scripts/build-items.ts
git commit -m "feat: add build script for items index"
```

---

## Task 6: Add get_items MCP Tool

**Files:**
- Modify: `src/index.ts`

**Step 1: Read current index.ts**

Review the existing file structure before modifying.

**Step 2: Add items index loading and get_items tool**

Add after the existing tool definitions (before server.connect):

```typescript
// Load items index
const itemsPath = new URL("../data/items.json", import.meta.url);
let itemsIndex: ItemsIndex | null = null;

try {
  itemsIndex = await Bun.file(itemsPath).json();
  console.error(`Loaded ${itemsIndex?.itemCount} items from ${itemsIndex?.listCount} lists`);
} catch {
  console.error("No items.json found - get_items will be unavailable");
}

// Tool: Get items from a list
if (itemsIndex) {
  server.tool(
    "get_items",
    "Get resources/items from an awesome list. Returns tools, libraries, and resources curated in the list.",
    {
      repo: z.string().describe("Repository name (e.g., 'vinta/awesome-python')"),
      category: z.string().optional().describe("Filter by category/section name"),
      limit: z.number().optional().describe("Maximum items to return (default: 50)"),
    },
    async ({ repo, category, limit = 50 }) => {
      const listEntry = itemsIndex!.lists[repo] || itemsIndex!.lists[repo.toLowerCase()];

      if (!listEntry) {
        return {
          content: [
            {
              type: "text",
              text: `List not found: ${repo}. Use the 'search' tool to find available lists.`,
            },
          ],
        };
      }

      let items = listEntry.items;

      // Filter by category if provided
      if (category) {
        const categoryLower = category.toLowerCase();
        items = items.filter(
          (i) =>
            i.category.toLowerCase().includes(categoryLower) ||
            i.subcategory?.toLowerCase().includes(categoryLower)
        );
      }

      // Apply limit
      items = items.slice(0, limit);

      // Format output
      const result = {
        repo,
        totalItems: listEntry.items.length,
        returnedItems: items.length,
        lastParsed: listEntry.lastParsed,
        items: items.map((i) => ({
          name: i.name,
          url: i.url,
          description: i.description,
          category: i.category,
          subcategory: i.subcategory,
          stars: i.github?.stars,
          language: i.github?.language,
        })),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
```

Also add import at top:

```typescript
import type { ItemsIndex } from "./types";
```

**Step 3: Test the server starts**

```bash
timeout 2 bun run src/index.ts 2>&1 || true
```

Expected: "Loaded X items from Y lists" message

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add get_items MCP tool"
```

---

## Task 7: Add GitHub Action

**Files:**
- Create: `.github/workflows/refresh-items.yml`

**Step 1: Create workflow file**

```yaml
# .github/workflows/refresh-items.yml
name: Refresh Items Index

on:
  schedule:
    - cron: '0 6 * * *'  # Daily at 6am UTC
  workflow_dispatch:      # Manual trigger

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Build items index
        run: bun run scripts/build-items.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Commit changes
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "chore: refresh items index"
          file_pattern: data/items.json
```

**Step 2: Create directory**

```bash
mkdir -p .github/workflows
```

**Step 3: Commit**

```bash
git add .github/workflows/refresh-items.yml
git commit -m "ci: add daily items refresh workflow"
```

---

## Task 8: Generate Initial Items Index

**Files:**
- Create: `data/items.json` (generated)

**Step 1: Run full build**

```bash
GITHUB_TOKEN=${GITHUB_TOKEN:-} bun run scripts/build-items.ts
```

Expected: Progress output, final count of items

**Step 2: Verify output size**

```bash
ls -lh data/items.json
wc -l data/items.json
```

Expected: 2-5MB file

**Step 3: Spot check data quality**

```bash
cat data/items.json | jq '.lists["vinta/awesome-python"].items[:3]'
```

Expected: Items with name, url, description, category, github metadata

**Step 4: Commit**

```bash
git add data/items.json
git commit -m "data: add initial items index"
```

---

## Task 9: Test via MCP Inspector

**Step 1: Start MCP Inspector**

```bash
npx @modelcontextprotocol/inspector bun run src/index.ts
```

**Step 2: Test get_items tool**

In the Inspector UI:
1. Connect to server
2. Select "get_items" tool
3. Enter: repo = "vinta/awesome-python"
4. Click "Run"

Expected: JSON response with items from awesome-python

**Step 3: Test category filter**

1. Enter: repo = "vinta/awesome-python", category = "Web Frameworks"
2. Click "Run"

Expected: Filtered items only from Web Frameworks category

**Step 4: Document test results**

Note any issues found for fixing.

---

## Task 10: Update README

**Files:**
- Modify: `README.md`

**Step 1: Add get_items documentation**

Add to the Tools section:

```markdown
### get_items

Get resources/items from an awesome list.

**Parameters:**
- `repo` (required): Repository name (e.g., "vinta/awesome-python")
- `category` (optional): Filter by category/section name
- `limit` (optional): Maximum items to return (default: 50)

**Example:**
```json
{
  "repo": "vinta/awesome-python",
  "category": "Web Frameworks",
  "limit": 10
}
```
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add get_items tool documentation"
```

---

## Final: Merge to Main

**Step 1: Review all commits**

```bash
git log --oneline main..HEAD
```

**Step 2: Push branch**

```bash
git push -u origin feature/get-items
```

**Step 3: Create PR or merge directly**

If merging directly:

```bash
git checkout main
git merge feature/get-items
git push
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add dependencies | package.json |
| 2 | Create types | src/types.ts |
| 3 | Create parser | src/parser.ts, src/parser.test.ts |
| 4 | Create enricher | src/enricher.ts, src/enricher.test.ts |
| 5 | Create build script | scripts/build-items.ts |
| 6 | Add MCP tool | src/index.ts |
| 7 | Add GitHub Action | .github/workflows/refresh-items.yml |
| 8 | Generate initial index | data/items.json |
| 9 | Test via Inspector | - |
| 10 | Update README | README.md |
