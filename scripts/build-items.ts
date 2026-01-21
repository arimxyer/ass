// scripts/build-items.ts
import { parseReadme } from "../src/parser";
import { batchEnrichItems, batchQueryListRepos } from "../src/enricher";
import { diffItems } from "../src/diff";
import { CONFIG } from "../src/config";
import type { ItemsIndex, Item } from "../src/types";

// Load list of awesome lists
const listsPath = new URL("../data/lists.json", import.meta.url);
let lists: { repo: string; name: string; stars: number }[] = await Bun.file(listsPath).json();

// Parse CLI arguments
const args = process.argv.slice(2);
let filterRepo: string | undefined;
let startIndex = 0;
let countLimit = Infinity;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--start" && args[i + 1]) {
    startIndex = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--count" && args[i + 1]) {
    countLimit = parseInt(args[i + 1], 10);
    i++;
  } else if (!args[i].startsWith("--")) {
    filterRepo = args[i];
  }
}

// Filter to specific repo if provided
if (filterRepo) {
  const filtered = lists.filter(l => l.repo.includes(filterRepo));
  if (filtered.length === 0) {
    console.error(`No lists found matching "${filterRepo}"`);
    process.exit(1);
  }
  lists = filtered;
  console.log(`Filtering to ${lists.length} list(s) matching "${filterRepo}"`);
}

// Apply range filtering
if (startIndex > 0 || countLimit < Infinity) {
  const originalCount = lists.length;
  lists = lists.slice(startIndex, startIndex + countLimit);
  console.log(`Range filter: lists ${startIndex} to ${startIndex + lists.length - 1} (${lists.length} of ${originalCount})`);
}

// Load existing items.json.gz if available (for incremental enrichment)
const outputPath = new URL("../data/items.json.gz", import.meta.url);
let existingIndex: ItemsIndex | null = null;

try {
  const compressed = await Bun.file(outputPath).arrayBuffer();
  const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
  existingIndex = JSON.parse(new TextDecoder().decode(decompressed));
  console.log(`Loaded existing index: ${existingIndex!.itemCount} items from ${existingIndex!.listCount} lists`);
} catch {
  console.log("No existing items.json.gz found, starting fresh");
}

// Load dead URLs blocklist
const deadUrlsPath = new URL("../data/deadUrls.json", import.meta.url);
let deadUrls: Set<string> = new Set();

try {
  const deadUrlsList: string[] = await Bun.file(deadUrlsPath).json();
  deadUrls = new Set(deadUrlsList);
  console.log(`Loaded ${deadUrls.size} dead URLs in blocklist`);
} catch {
  console.log("No deadUrls.json found, starting with empty blocklist");
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
        const res = await fetch(url, {
          signal: AbortSignal.timeout(CONFIG.network.timeout),
        });
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

    // Parse new items and filter out dead URLs
    const newItems = parseReadme(readme).filter(item => !deadUrls.has(item.url));
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
          const res = await fetch(url, {
            signal: AbortSignal.timeout(CONFIG.network.timeout),
          });
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

      const newItems = parseReadme(readme).filter(item => !deadUrls.has(item.url));
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
        allAddedItems.push({ ...item, sourceList: list.repo });
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

// Copy fresh (unchanged) lists from existing index
for (const list of freshLists) {
  if (existingIndex?.lists[list.repo]) {
    index.lists[list.repo] = existingIndex.lists[list.repo];
    index.listCount++;
  }
}

// Merge mode: when filtering (by repo or range), preserve unmodified lists from existing index
const isFiltering = filterRepo || startIndex > 0 || countLimit < Infinity;
if (isFiltering && existingIndex) {
  let preserved = 0;
  for (const [repo, entry] of Object.entries(existingIndex.lists)) {
    if (!index.lists[repo]) {
      index.lists[repo] = entry;
      index.listCount++;
      preserved++;
    }
  }
  if (preserved > 0) {
    console.log(`\nMerge mode: preserved ${preserved} other lists from existing index`);
  }
}

// Log stats about new items
const newGithubItems = allAddedItems.filter(item =>
  item.url.startsWith("https://github.com/")
);
console.log(`\n${allAddedItems.length} new items, ${newGithubItems.length} are GitHub URLs`);

// Determine which lists to enrich (only processed lists, not merged ones)
const processedListRepos = new Set(lists.map(l => l.repo));

// Collect items missing GitHub metadata from PROCESSED lists only
const itemsToEnrich: (Item & { sourceList: string })[] = [];
for (const [repo, entry] of Object.entries(index.lists)) {
  if (!processedListRepos.has(repo)) continue; // Skip merged lists
  for (const item of entry.items) {
    if (item.url.startsWith("https://github.com/") && !item.github) {
      itemsToEnrich.push({ ...item, sourceList: repo });
    }
  }
}

console.log(`${itemsToEnrich.length} GitHub URLs missing metadata`);

// Rolling re-check: collect oldest 1000 items by lastEnriched for staleness check
const RECHECK_BATCH_SIZE = 1000;
const allIndexedItems: (Item & { sourceList: string })[] = [];
for (const [repo, entry] of Object.entries(index.lists)) {
  for (const item of entry.items) {
    if (
      item.url.startsWith("https://github.com/") &&
      item.github &&
      !("notFound" in item.github) &&
      item.lastEnriched
    ) {
      allIndexedItems.push({ ...item, sourceList: repo });
    }
  }
}

// Sort by lastEnriched (oldest first) and take oldest batch
const staleItems = allIndexedItems
  .sort((a, b) => (a.lastEnriched || "").localeCompare(b.lastEnriched || ""))
  .slice(0, RECHECK_BATCH_SIZE);

if (staleItems.length > 0) {
  const oldestDate = staleItems[0].lastEnriched?.split("T")[0];
  console.log(`${staleItems.length} items queued for staleness re-check (oldest from ${oldestDate})`);
  itemsToEnrich.push(...staleItems);
}

// Enrich items (new + stale re-check)
if (itemsToEnrich.length > 0) {
  console.log("\nEnriching with GitHub metadata...");
  await batchEnrichItems(itemsToEnrich);

  // Update index with enriched items
  for (const item of itemsToEnrich) {
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

// Remove dead items (marked with notFound) and add to blocklist
let removedCount = 0;
for (const entry of Object.values(index.lists)) {
  const before = entry.items.length;
  entry.items = entry.items.filter(item => {
    if (item.github && "notFound" in item.github) {
      deadUrls.add(item.url); // Add to blocklist
      return false; // Remove dead items
    }
    return true;
  });
  removedCount += before - entry.items.length;
}

if (removedCount > 0) {
  console.log(`Removed ${removedCount} dead items (added to blocklist)`);
}

// Count total items
index.itemCount = Object.values(index.lists).reduce((sum, l) => sum + l.items.length, 0);

// Write output as gzipped JSON (smaller for CDN delivery)
const jsonString = JSON.stringify(index);
const gzipped = Bun.gzipSync(Buffer.from(jsonString));
const gzipPath = new URL("../data/items.json.gz", import.meta.url);
await Bun.write(gzipPath, gzipped);

const sizeMB = (gzipped.length / 1024 / 1024).toFixed(1);
console.log(`\nWrote ${index.itemCount} items to data/items.json.gz (${sizeMB}MB gzipped)`);

// Write dead URLs blocklist
const deadUrlsList = Array.from(deadUrls).sort();
await Bun.write(deadUrlsPath, JSON.stringify(deadUrlsList, null, 2));
console.log(`Wrote ${deadUrlsList.length} URLs to deadUrls.json`);
