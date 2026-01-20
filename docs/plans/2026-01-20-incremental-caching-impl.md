# Incremental Caching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the build script only fetch/parse/enrich what actually changed, reducing redundant work by ~95% on typical runs.

**Architecture:** Two-phase freshness check: (1) batch query list repos for `pushedAt` to skip unchanged lists, (2) diff parsed items against cached items to only enrich new GitHub URLs. Deferred retry strategy for transient failures.

**Tech Stack:** Bun, TypeScript, GitHub GraphQL API, existing enricher batching logic.

**Design Doc:** `docs/plans/2026-01-20-incremental-caching-design.md`

---

## Task 1: Add `batchQueryListRepos` Function

**Files:**
- Modify: `src/enricher.ts`
- Modify: `src/enricher.test.ts`

**Step 1: Write the failing test**

Add to `src/enricher.test.ts`:

```typescript
import { batchQueryListRepos } from "./enricher";

describe("batchQueryListRepos", () => {
  it("returns pushedAt for valid repos", async () => {
    const repos = ["sindresorhus/awesome", "avelino/awesome-go"];
    const result = await batchQueryListRepos(repos);

    expect(result.size).toBe(2);
    expect(result.get("sindresorhus/awesome")?.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.get("avelino/awesome-go")?.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns null for non-existent repos", async () => {
    const repos = ["this-org-does-not-exist-12345/fake-repo"];
    const result = await batchQueryListRepos(repos);

    expect(result.get("this-org-does-not-exist-12345/fake-repo")).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `GITHUB_TOKEN=$(gh auth token) bun test src/enricher.test.ts -t "batchQueryListRepos"`
Expected: FAIL with "batchQueryListRepos is not a function" or similar

**Step 3: Write minimal implementation**

Add to `src/enricher.ts`:

```typescript
export async function batchQueryListRepos(
  repos: string[]
): Promise<Map<string, { pushedAt: string } | null>> {
  const results = new Map<string, { pushedAt: string } | null>();
  const BATCH_SIZE = 50;

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(repos.length / BATCH_SIZE);
    process.stdout.write(`  [${batchNum}/${totalBatches}]`);

    // Build GraphQL query for this batch
    const repoQueries = batch.map((repo, idx) => {
      const [owner, name] = repo.split("/");
      return `repo${idx}: repository(owner: "${owner}", name: "${name}") {
        pushedAt
      }`;
    });

    const query = `query { ${repoQueries.join("\n")} }`;

    try {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      const json = await response.json();

      if (json.errors && !json.data) {
        console.error(`  Error batch ${batchNum}:`, json.errors[0]?.message);
        // Mark all repos in batch as null
        for (const repo of batch) {
          results.set(repo, null);
        }
        continue;
      }

      // Extract results
      batch.forEach((repo, idx) => {
        const data = json.data?.[`repo${idx}`];
        if (data?.pushedAt) {
          results.set(repo, { pushedAt: data.pushedAt });
        } else {
          results.set(repo, null);
        }
      });
    } catch (error: any) {
      console.error(`  Error batch ${batchNum}:`, error.message);
      for (const repo of batch) {
        results.set(repo, null);
      }
    }
  }

  console.log(); // newline after progress
  return results;
}
```

**Step 4: Run test to verify it passes**

Run: `GITHUB_TOKEN=$(gh auth token) bun test src/enricher.test.ts -t "batchQueryListRepos"`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/enricher.ts src/enricher.test.ts
git commit -m "feat: add batchQueryListRepos for list freshness check"
```

---

## Task 2: Add `diffItems` Function

**Files:**
- Create: `src/diff.ts`
- Create: `src/diff.test.ts`
- Modify: `src/types.ts`

**Step 1: Add DiffResult type**

Add to `src/types.ts`:

```typescript
export interface DiffResult {
  added: Item[];
  removed: Item[];
  unchanged: Item[];
  updated: Item[];
}
```

**Step 2: Write the failing test**

Create `src/diff.test.ts`:

```typescript
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
```

**Step 3: Run test to verify it fails**

Run: `bun test src/diff.test.ts`
Expected: FAIL with "Cannot find module './diff'"

**Step 4: Write minimal implementation**

Create `src/diff.ts`:

```typescript
import type { Item, DiffResult } from "./types";

export function diffItems(oldItems: Item[], newItems: Item[]): DiffResult {
  const oldByUrl = new Map(oldItems.map(i => [i.url, i]));
  const newByUrl = new Map(newItems.map(i => [i.url, i]));

  const added: Item[] = [];
  const removed: Item[] = [];
  const unchanged: Item[] = [];
  const updated: Item[] = [];

  // Check new items against old
  for (const newItem of newItems) {
    const oldItem = oldByUrl.get(newItem.url);
    if (!oldItem) {
      added.push(newItem);
    } else if (oldItem.name === newItem.name && oldItem.description === newItem.description) {
      // Unchanged - preserve enrichment data from old item
      unchanged.push({
        ...newItem,
        github: oldItem.github,
        lastEnriched: oldItem.lastEnriched,
      });
    } else {
      // Updated - preserve enrichment data, use new metadata
      updated.push({
        ...newItem,
        github: oldItem.github,
        lastEnriched: oldItem.lastEnriched,
      });
    }
  }

  // Find removed items
  for (const oldItem of oldItems) {
    if (!newByUrl.has(oldItem.url)) {
      removed.push(oldItem);
    }
  }

  return { added, removed, unchanged, updated };
}
```

**Step 5: Run test to verify it passes**

Run: `bun test src/diff.test.ts`
Expected: PASS (5 tests)

**Step 6: Commit**

```bash
git add src/types.ts src/diff.ts src/diff.test.ts
git commit -m "feat: add diffItems function for incremental updates"
```

---

## Task 3: Refactor Build Script - List Freshness Check

**Files:**
- Modify: `scripts/build-items.ts`

**Step 1: Add list freshness check after loading existing index**

Replace the section after loading existing index with:

```typescript
import { batchEnrichItems, batchQueryListRepos } from "../src/enricher";
import { diffItems } from "../src/diff";

// ... existing code to load lists and existingIndex ...

// Query all list repos for freshness
console.log(`\nQuerying ${lists.length} list repos for freshness...`);
const listMetadata = await batchQueryListRepos(lists.map(l => l.repo));

// Determine which lists need re-parsing
const staleLists: typeof lists = [];
const freshLists: typeof lists = [];

for (const list of lists) {
  const cached = existingIndex?.lists[list.repo];
  const remote = listMetadata.get(list.repo);

  if (!cached || !remote || remote.pushedAt > cached.lastParsed) {
    staleLists.push(list);
  } else {
    freshLists.push(list);
  }
}

console.log(`  ${staleLists.length} lists need re-parsing`);
console.log(`  ${freshLists.length} lists unchanged (using cache)`);
```

**Step 2: Run manually to verify freshness check works**

Run: `GITHUB_TOKEN=$(gh auth token) bun scripts/build-items.ts sindresorhus/awesome 2>&1 | head -20`
Expected: Shows freshness query output with counts

**Step 3: Commit**

```bash
git add scripts/build-items.ts
git commit -m "feat: add list freshness check to build script"
```

---

## Task 4: Refactor Build Script - Diff-Based Processing

**Files:**
- Modify: `scripts/build-items.ts`

**Step 1: Replace full list processing with diff-based processing**

Update the main loop to:

```typescript
// Process only stale lists
let allAddedItems: (Item & { sourceList: string })[] = [];
let failedLists: typeof staleLists = [];

for (let i = 0; i < staleLists.length; i++) {
  const list = staleLists[i];
  const progress = `[${i + 1}/${staleLists.length}]`;

  try {
    // Fetch README
    let readme: string | null = null;
    outer: for (const branch of ["main", "master"]) {
      for (const filename of ["README.md", "readme.md"]) {
        const url = `https://raw.githubusercontent.com/${list.repo}/${branch}/${filename}`;
        const res = await fetch(url);
        if (res.ok) {
          readme = await res.text();
          break outer;
        }
      }
    }

    if (!readme) {
      console.log(`${progress} ${list.repo} - README not found, skipping`);
      continue;
    }

    // Parse new items
    const newItems = parseReadme(readme);
    const oldItems = existingIndex?.lists[list.repo]?.items ?? [];

    // Diff
    const diff = diffItems(oldItems, newItems);
    console.log(
      `${progress} ${list.repo} - +${diff.added.length} added, -${diff.removed.length} removed, ${diff.unchanged.length + diff.updated.length} kept`
    );

    // Store in index (unchanged + updated already have enrichment preserved)
    const remote = listMetadata.get(list.repo);
    index.lists[list.repo] = {
      lastParsed: new Date().toISOString(),
      pushedAt: remote?.pushedAt ?? "",
      items: [...diff.unchanged, ...diff.updated, ...diff.added],
    };

    // Collect added items for enrichment
    for (const item of diff.added) {
      allAddedItems.push({ ...item, sourceList: list.repo });
    }

    index.listCount++;
  } catch (error: any) {
    console.error(`${progress} ${list.repo} - Error: ${error.message}`);
    failedLists.push(list);
  }
}

// Copy fresh (unchanged) lists from existing index
for (const list of freshLists) {
  if (existingIndex?.lists[list.repo]) {
    index.lists[list.repo] = existingIndex.lists[list.repo];
    index.listCount++;
  }
}
```

**Step 2: Run manually to verify diff output**

Run: `GITHUB_TOKEN=$(gh auth token) bun scripts/build-items.ts jaywcjlove/awesome-mac 2>&1`
Expected: Shows diff counts (+N added, -N removed, N kept)

**Step 3: Commit**

```bash
git add scripts/build-items.ts
git commit -m "feat: add diff-based processing to build script"
```

---

## Task 5: Filter Non-GitHub URLs Before Enrichment

**Files:**
- Modify: `scripts/build-items.ts`

**Step 1: Filter to GitHub URLs only before enrichment**

Replace the enrichment section with:

```typescript
// Filter to GitHub URLs only
const githubItems = allAddedItems.filter(item =>
  item.url.startsWith("https://github.com/")
);

console.log(`\n${allAddedItems.length} new items, ${githubItems.length} are GitHub URLs`);

// Enrich only GitHub items
if (githubItems.length > 0) {
  console.log("\nEnriching with GitHub metadata...");
  await batchEnrichItems(githubItems);

  // Update index with enriched items
  for (const item of githubItems) {
    const { sourceList, ...cleanItem } = item;
    const listEntry = index.lists[sourceList];
    if (listEntry) {
      const idx = listEntry.items.findIndex(i => i.url === cleanItem.url);
      if (idx >= 0) {
        listEntry.items[idx] = cleanItem;
      }
    }
  }
}
```

**Step 2: Run manually to verify filtering**

Run: `GITHUB_TOKEN=$(gh auth token) bun scripts/build-items.ts jaywcjlove/awesome-mac 2>&1`
Expected: Shows "X new items, Y are GitHub URLs" with Y < X

**Step 3: Commit**

```bash
git add scripts/build-items.ts
git commit -m "feat: filter non-GitHub URLs before enrichment"
```

---

## Task 6: Add Deferred Retry Strategy

**Files:**
- Modify: `scripts/build-items.ts`

**Step 1: Add retry passes after main loop**

Add after the main processing loop:

```typescript
// Deferred retry passes (up to 3)
for (let attempt = 1; attempt <= 3 && failedLists.length > 0; attempt++) {
  console.log(`\nRetry pass ${attempt}: ${failedLists.length} lists`);
  const stillFailed: typeof failedLists = [];

  for (const list of failedLists) {
    try {
      let readme: string | null = null;
      outer: for (const branch of ["main", "master"]) {
        for (const filename of ["README.md", "readme.md"]) {
          const url = `https://raw.githubusercontent.com/${list.repo}/${branch}/${filename}`;
          const res = await fetch(url);
          if (res.ok) {
            readme = await res.text();
            break outer;
          }
        }
      }

      if (!readme) {
        console.log(`  ${list.repo} - README still not found`);
        stillFailed.push(list);
        continue;
      }

      const newItems = parseReadme(readme);
      const oldItems = existingIndex?.lists[list.repo]?.items ?? [];
      const diff = diffItems(oldItems, newItems);
      console.log(`  ${list.repo} - success (+${diff.added.length}, -${diff.removed.length})`);

      const remote = listMetadata.get(list.repo);
      index.lists[list.repo] = {
        lastParsed: new Date().toISOString(),
        pushedAt: remote?.pushedAt ?? "",
        items: [...diff.unchanged, ...diff.updated, ...diff.added],
      };

      for (const item of diff.added) {
        if (item.url.startsWith("https://github.com/")) {
          allAddedItems.push({ ...item, sourceList: list.repo });
        }
      }

      index.listCount++;
    } catch (error: any) {
      console.log(`  ${list.repo} - still failing: ${error.message}`);
      stillFailed.push(list);
    }
  }

  failedLists = stillFailed;
}

if (failedLists.length > 0) {
  console.warn(`\n${failedLists.length} lists failed after 3 retries:`);
  for (const list of failedLists) {
    console.warn(`  - ${list.repo}`);
  }
}
```

**Step 2: Commit**

```bash
git add scripts/build-items.ts
git commit -m "feat: add deferred retry strategy for failed lists"
```

---

## Task 7: Add Merge Mode for CLI Filtering

**Files:**
- Modify: `scripts/build-items.ts`

**Step 1: Add merge logic when CLI filter is used**

Add after copying fresh lists, before writing output:

```typescript
// Merge mode: when filtering, preserve unmodified lists from existing index
if (filterRepo && existingIndex) {
  for (const [repo, entry] of Object.entries(existingIndex.lists)) {
    if (!index.lists[repo]) {
      index.lists[repo] = entry;
      index.listCount++;
    }
  }
  console.log(`\nMerge mode: preserved ${Object.keys(existingIndex.lists).length - staleLists.length - freshLists.length} other lists`);
}
```

**Step 2: Run manually to verify merge mode**

Run: `GITHUB_TOKEN=$(gh auth token) bun scripts/build-items.ts sindresorhus/awesome 2>&1`
Expected: Shows "Merge mode: preserved X other lists"

**Step 3: Commit**

```bash
git add scripts/build-items.ts
git commit -m "feat: add merge mode for CLI single-list filtering"
```

---

## Task 8: Full Integration Test

**Files:**
- None (manual testing)

**Step 1: Run full build on a small subset**

Run: `GITHUB_TOKEN=$(gh auth token) bun scripts/build-items.ts awesome-mac`
Expected: Full incremental flow with freshness check, diff, enrichment

**Step 2: Run again immediately to verify caching**

Run: `GITHUB_TOKEN=$(gh auth token) bun scripts/build-items.ts awesome-mac`
Expected: "0 lists need re-parsing" (all cached)

**Step 3: Verify items.json structure**

Run: `jq '.lists["jaywcjlove/awesome-mac"] | {lastParsed, pushedAt, itemCount: (.items | length)}' data/items.json`
Expected: Shows lastParsed, pushedAt (populated), and item count

**Step 4: Run all tests**

Run: `GITHUB_TOKEN=$(gh auth token) bun test`
Expected: All tests pass

**Step 5: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: integration test cleanup"
```

---

## Summary

| Task | Description | Tests |
|------|-------------|-------|
| 1 | `batchQueryListRepos` function | 2 tests |
| 2 | `diffItems` function | 5 tests |
| 3 | List freshness check in build script | Manual |
| 4 | Diff-based processing | Manual |
| 5 | Filter non-GitHub URLs | Manual |
| 6 | Deferred retry strategy | Manual |
| 7 | Merge mode for CLI | Manual |
| 8 | Full integration test | Manual |

**Total new tests:** 7
**Estimated commits:** 8
