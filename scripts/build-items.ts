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
const outputPath = new URL("../data/items.json", import.meta.url);
await Bun.write(outputPath, JSON.stringify(index, null, 2));

console.log(`\nWrote ${index.itemCount} items to data/items.json`);
