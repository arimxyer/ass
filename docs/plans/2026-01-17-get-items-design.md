# get_items Tool Design

## Overview

Add a `get_items` MCP tool to retrieve resources/items from within awesome lists. This complements the existing list-discovery tools (`search`, `get_list`, `top_lists`, `stats`) by enabling users to explore the actual content inside lists.

## Scope

**Building:**
- `get_items` tool to retrieve items from a specific awesome list
- Pre-indexed item data with daily refresh
- GitHub metadata enrichment (stars, language, last commit)
- Full markdown AST parsing with `mdast-util-from-markdown`

**Not Building:**
- Cross-list section search (`find_section`) - users can use existing `search` tool to find lists, then call `get_items` on each

## Tool Signature

```typescript
server.tool(
  "get_items",
  "Get resources/items from an awesome list",
  {
    repo: z.string().describe("Repository (e.g., 'vinta/awesome-python')"),
    category: z.string().optional().describe("Filter by category/section"),
    limit: z.number().optional().describe("Max items to return (default: 50)"),
  },
  async ({ repo, category, limit = 50 }) => { /* ... */ }
);
```

## Data Pipeline

### Build-time Indexing (runs daily via GitHub Action)

1. **Fetch** - Download READMEs for all 631 lists from GitHub raw
2. **Parse** - Use `mdast-util-from-markdown` to convert markdown → AST → structured items
3. **Deduplicate** - Many repos appear in multiple lists, consolidate by URL
4. **Enrich** - Batch query GitHub GraphQL API for metadata (stars, language, last commit)
5. **Output** - Write `data/items.json` with enriched items

### Incremental Updates

Not a full rebuild each day. Instead:

**README changes:**
- Query `pushed_at` timestamp for each list
- Only re-fetch and re-parse READMEs that changed since last index
- Estimated: ~5-20 lists change per day

**GitHub metadata:**
- Each item tracks its own `lastEnriched` timestamp
- Refresh cadence based on star tier:
  - <500 stars: less frequent
  - 500-1000: moderate
  - 1000-5000: more frequent
  - 10000+: most frequent
- Items update atomically, not whole-list rebuilds

## Data Schema

```typescript
interface ItemsIndex {
  generatedAt: string;
  listCount: number;
  itemCount: number;
  lists: {
    [repo: string]: ListEntry;
  };
}

interface ListEntry {
  lastParsed: string;      // When we parsed this README
  pushedAt: string;        // GitHub's pushed_at (detect changes)
  items: Item[];
}

interface Item {
  name: string;            // "FastAPI"
  url: string;             // "https://github.com/tiangolo/fastapi"
  description: string;     // "High performance web framework..."
  category: string;        // "Web Frameworks"
  subcategory?: string;    // "ASGI" (if nested)
  lastEnriched?: string;   // Per-item tracking
  github?: {
    stars: number;         // 82451
    language: string;      // "Python"
    pushedAt: string;      // "2026-01-15T10:30:00Z"
  };
}
```

## Parser Implementation

**Technology:** `mdast-util-from-markdown` (works with Bun, unlike `unist-util-visit`)

**Parsing logic:**
1. Parse markdown to AST
2. Walk tree, tracking current heading hierarchy:
   - `## Heading` → category
   - `### Heading` → subcategory
3. For each list item:
   - Extract link: `[name](url)`
   - Extract description: text after the link
   - Associate with current category/subcategory
4. Output structured items

**Non-GitHub URLs:** Keep the item, skip enrichment, set `github: null`

## GitHub Action

```yaml
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
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run scripts/build-items.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "chore: refresh items index"
          file_pattern: data/items.json
```

## Runtime Behavior

1. MCP server starts, fetches `data/items.json` from jsDelivr CDN (or bundled locally)
2. Loads into memory as indexed map
3. `get_items(repo)` does instant lookup - no network requests
4. Optional: periodic refresh from CDN during long-running sessions

## Dependencies

| Package | Purpose |
|---------|---------|
| `mdast-util-from-markdown` | Markdown → AST parsing |
| `octokit` | GitHub API (enrichment, pushed_at checks) |

## Implementation Order

**Phase 1: Parser + Indexer**
1. Create `scripts/build-items.ts`
2. Implement README fetching
3. Implement markdown parsing with mdast
4. Implement GitHub enrichment
5. Generate initial `data/items.json`
6. Validate output quality

**Phase 2: MCP Tool**
1. Add `get_items` tool to `src/index.ts`
2. Load `data/items.json` at startup
3. Implement category filtering and limit
4. Test via MCP Inspector

**Phase 3: Automation**
1. Add GitHub Action for daily refresh
2. Test the full cycle
3. Update README with new tool documentation

## Estimated Data Size

- ~10,000-15,000 unique items across 631 lists
- ~2-3MB JSON file (gzipped ~500KB)

## Rate Limit Handling

GitHub GraphQL API: 100 repos per query, 5,000 requests/hr with auth token.
~150 requests for 15k repos = well within limits.
