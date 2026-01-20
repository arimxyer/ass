# Incremental Caching Design

## Problem

The current build script has several inefficiencies:

1. **Re-fetches all READMEs** on every run, even when lists haven't changed
2. **Non-GitHub items** pass through the enricher wastefully (880 of 1058 items in awesome-mac)
3. **No granular diffing** - if one item changes, we re-process the entire list
4. **No retry strategy** - transient failures cause items to be skipped

## Solution

Incremental updates that only fetch, parse, and enrich what actually changed.

## High-Level Flow

```
1. Load existing items.json
2. Batch query all list repos for `pushedAt` timestamps (GraphQL)
3. For each list:
   - If pushedAt <= lastParsed → skip (use cached items)
   - If pushedAt > lastParsed → fetch README, parse, diff
4. Diff produces: added, removed, unchanged, updated items
5. Filter added items to GitHub URLs only → send to enricher
6. Merge results: keep unchanged, add new (with enrichment), remove deleted
7. Write items.json (merge mode if filtered, full write otherwise)
```

## Data Structures

### ListEntry (no changes, just populate `pushedAt`)

```typescript
interface ListEntry {
  lastParsed: string;    // When we last parsed the README
  pushedAt: string;      // When the list repo was last pushed (from GitHub)
  items: Item[];
}
```

### DiffResult (internal to build script)

```typescript
interface DiffResult {
  added: Item[];      // New URLs not in previous index
  removed: Item[];    // URLs no longer in README
  unchanged: Item[];  // Same URL, keep existing enrichment
  updated: Item[];    // Same URL, metadata changed - keep enrichment
}
```

## Build Script Logic

### Step 1: Query list freshness

```typescript
const existing = await loadExistingIndex();
const listMetadata = await batchQueryListRepos(lists);

const staleLists = lists.filter(list => {
  const cached = existing?.lists[list.repo];
  const remote = listMetadata.get(list.repo);
  return !cached || !remote || remote.pushedAt > cached.lastParsed;
});

console.log(`${staleLists.length}/${lists.length} lists need re-parsing`);
```

### Step 2: Fetch & diff only stale lists

```typescript
for (const list of staleLists) {
  const readme = await fetchReadme(list.repo);
  const newItems = parseReadme(readme);
  const oldItems = existing?.lists[list.repo]?.items ?? [];

  const diff = diffItems(oldItems, newItems);
  // diff.added → need enrichment (if GitHub URL)
  // diff.removed → delete from index
  // diff.unchanged + diff.updated → keep existing enrichment
}
```

### Step 3: Enrich only new GitHub items

```typescript
const toEnrich = allAddedItems.filter(item =>
  item.url.startsWith('https://github.com/')
);
await batchEnrichItems(toEnrich);
```

## New Functions

### 1. `batchQueryListRepos(lists)` in enricher.ts

Similar to existing `batchEnrichItems`, but queries the list repos themselves. Returns `Map<repo, { pushedAt: string }>`. Uses same batching/rate-limit logic.

### 2. `diffItems(oldItems, newItems)`

```typescript
function diffItems(oldItems: Item[], newItems: Item[]): DiffResult {
  const oldByUrl = new Map(oldItems.map(i => [i.url, i]));
  const newByUrl = new Map(newItems.map(i => [i.url, i]));

  const added = newItems.filter(i => !oldByUrl.has(i.url));
  const removed = oldItems.filter(i => !newByUrl.has(i.url));
  const unchanged = newItems.filter(i => {
    const old = oldByUrl.get(i.url);
    return old && old.name === i.name && old.description === i.description;
  });
  const updated = newItems.filter(i => {
    const old = oldByUrl.get(i.url);
    return old && (old.name !== i.name || old.description !== i.description);
  });

  return { added, removed, unchanged, updated };
}
```

## Merge Mode (CLI filtering)

When using CLI filter (`bun scripts/build-items.ts awesome-go`), merge results into existing index instead of overwriting:

```typescript
if (filterRepo) {
  for (const [repo, entry] of Object.entries(existing.lists)) {
    if (!lists.some(l => l.repo === repo)) {
      index.lists[repo] = entry; // Keep unmodified lists
    }
  }
}
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| List repo deleted/renamed | `batchQueryListRepos` returns null → skip, keep stale data |
| README fetch fails | Keep existing cached items, log warning, add to retry queue |
| First run (no existing index) | All lists are "stale", full build |
| Empty diff | List pushed but no item changes → update `lastParsed`, keep items |

## Deferred Retry Strategy

Instead of immediate retries that slow down the main run, use deferred passes:

```
Pass 1: Try all stale lists
  → 10 succeed, 2 fail (log failures)

Pass 2: Retry the 2 failed lists
  → 1 succeeds, 1 fails

Pass 3: Retry the 1 failed list
  → Still fails → log final warning, continue without it
```

Implementation:

```typescript
let failedLists: typeof staleLists = [];

// First pass
for (const list of staleLists) {
  try { /* fetch, parse, diff */ }
  catch { failedLists.push(list); }
}

// Retry passes (up to 3)
for (let attempt = 1; attempt <= 3 && failedLists.length > 0; attempt++) {
  console.log(`Retry pass ${attempt}: ${failedLists.length} lists`);
  const stillFailed: typeof failedLists = [];
  for (const list of failedLists) {
    try { /* fetch, parse, diff */ }
    catch { stillFailed.push(list); }
  }
  failedLists = stillFailed;
}

if (failedLists.length > 0) {
  console.warn(`${failedLists.length} lists failed after 3 retries`);
}
```

## Expected Logging Output

```
Querying 631 list repos for freshness...
  12 lists have updates since last parse
  619 lists unchanged (using cache)

Parsing 12 updated lists...
  awesome-go: +5 added, -2 removed, 2790 unchanged
  awesome-rust: +12 added, -0 removed, 1503 unchanged
  ...

Enriching 14 new GitHub items...
  [1/1] batch complete

Retry pass 1: 1 list
  awesome-broken: success

Wrote 164,523 items to data/items.json
  Updated: 12 lists
  Cached: 619 lists
```

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| URL-only item identity | Simple, stable identifier. Covers 99% of cases. |
| Filter non-GitHub before enricher | Avoid passing 880 items through enricher that will be ignored |
| `pushedAt` trigger for re-parse | Most efficient - single GraphQL query determines freshness |
| Deferred retries | Transient issues resolve; main run isn't slowed |
| Merge mode for CLI filter | Non-destructive testing of individual lists |
