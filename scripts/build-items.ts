// scripts/build-items.ts
import { parseReadme } from "../src/parser";
import { batchEnrichItems, batchQueryListRepos } from "../src/enricher";
import { diffItems } from "../src/diff";
import type { ItemsIndex, Item } from "../src/types";

// Load list of awesome lists
const listsPath = new URL("../data/lists.json", import.meta.url);
let lists: { repo: string; name: string; stars: number }[] = await Bun.file(listsPath).json();

// Filter to specific repo if provided as CLI argument
const filterRepo = process.argv[2];
if (filterRepo) {
  const filtered = lists.filter(l => l.repo.includes(filterRepo));
  if (filtered.length === 0) {
    console.error(`No lists found matching "${filterRepo}"`);
    process.exit(1);
  }
  lists = filtered;
  console.log(`Filtering to ${lists.length} list(s) matching "${filterRepo}"`);
}

// Load existing items.json if available (for incremental enrichment)
const outputPath = new URL("../data/items.json", import.meta.url);
let existingIndex: ItemsIndex | null = null;

try {
  existingIndex = await Bun.file(outputPath).json();
  console.log(`Loaded existing index: ${existingIndex!.itemCount} items from ${existingIndex!.listCount} lists`);
} catch {
  console.log("No existing items.json found, starting fresh");
}

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

console.log(`\nBuilding items index for ${staleLists.length} stale lists...`);

const index: ItemsIndex = {
  generatedAt: new Date().toISOString(),
  listCount: 0,
  itemCount: 0,
  lists: {},
};

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

console.log(`\nDiff summary: ${allAddedItems.length} new items to enrich`);

// Enrich only new items
if (allAddedItems.length > 0) {
  console.log("\nEnriching with GitHub metadata...");
  await batchEnrichItems(allAddedItems);

  // Update index with enriched items
  for (const item of allAddedItems) {
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

// Count total items
index.itemCount = Object.values(index.lists).reduce((sum, l) => sum + l.items.length, 0);

// Write output
await Bun.write(outputPath, JSON.stringify(index, null, 2));

console.log(`\nWrote ${index.itemCount} items to data/items.json`);
