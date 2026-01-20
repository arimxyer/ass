// scripts/build-items.ts
import { parseReadme } from "../src/parser";
import { batchEnrichItems } from "../src/enricher";
import type { ItemsIndex, ListEntry, Item } from "../src/types";

// Configuration
const STALE_DAYS = 7; // Re-enrich repos older than this
const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;

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
const existingEnrichments = new Map<string, { lastEnriched: string; github: Item["github"] }>();

try {
  existingIndex = await Bun.file(outputPath).json();
  console.log(`Loaded existing index: ${existingIndex!.itemCount} items from ${existingIndex!.listCount} lists`);

  // Build map of existing enrichments by URL for fast lookup
  for (const listEntry of Object.values(existingIndex!.lists)) {
    for (const item of listEntry.items) {
      if (item.lastEnriched && item.github) {
        existingEnrichments.set(item.url, {
          lastEnriched: item.lastEnriched,
          github: item.github,
        });
      }
    }
  }
  console.log(`Found ${existingEnrichments.size} previously enriched items`);
} catch {
  console.log("No existing items.json found, starting fresh");
}

console.log(`\nBuilding items index for ${lists.length} lists...`);

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
    // Try main branch first, then master, with both README.md and readme.md
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

// Separate items into fresh (use cached) vs stale/new (need enrichment)
const now = Date.now();
const itemsToEnrich: typeof allItems = [];
let cachedCount = 0;

for (const item of allItems) {
  const existing = existingEnrichments.get(item.url);
  if (existing) {
    const age = now - new Date(existing.lastEnriched).getTime();
    if (age < staleMs) {
      // Use cached enrichment
      item.lastEnriched = existing.lastEnriched;
      item.github = existing.github;
      cachedCount++;
      continue;
    }
  }
  // New or stale - needs enrichment
  itemsToEnrich.push(item);
}

console.log(`\nIncremental enrichment: ${cachedCount} cached, ${itemsToEnrich.length} to enrich`);

// Enrich only the items that need it
let enriched: typeof allItems;
if (itemsToEnrich.length > 0) {
  console.log("\nEnriching with GitHub metadata...");
  await batchEnrichItems(itemsToEnrich);
}
// Combine: allItems already has cached items updated, itemsToEnrich items are now enriched
enriched = allItems;

// Update index with enriched items
for (const item of enriched) {
  const { sourceList, ...cleanItem } = item as Item & { sourceList: string };
  const listEntry = index.lists[sourceList];
  if (listEntry) {
    const idx = listEntry.items.findIndex(i => i.url === cleanItem.url);
    if (idx >= 0) {
      listEntry.items[idx] = cleanItem;
    }
  }
}

// Count total items
index.itemCount = Object.values(index.lists).reduce((sum, l) => sum + l.items.length, 0);

// Write output
await Bun.write(outputPath, JSON.stringify(index, null, 2));

console.log(`\nWrote ${index.itemCount} items to data/items.json`);
