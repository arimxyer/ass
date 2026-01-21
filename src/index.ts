#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import MiniSearch from "minisearch";
import { z } from "zod";
import { CONFIG } from "./config";
import { loadData } from "./data-loader";
import {
  type ItemsIndex,
  type Item,
  type AwesomeList,
  hasGitHubMetadata,
  AwesomeListSchema,
  ItemsIndexSchema,
} from "./types";

interface IndexedItem extends Item {
  id: number;
  listRepo: string;
}

/** Result type for list search results */
interface ListResult {
  repo: string;
  name: string;
  stars: number;
  description: string;
  lastUpdated?: string;
  source?: string;
  githubUrl?: string;
}

// Load required data with crash protection
let lists: AwesomeList[];
let itemsIndex: ItemsIndex;

try {
  lists = await loadData({
    filename: "lists.json",
    schema: z.array(AwesomeListSchema),
  });

  itemsIndex = await loadData({
    filename: "items.json.gz",
    schema: ItemsIndexSchema,
    gzipped: true,
  });
} catch (e) {
  if (e instanceof z.ZodError) {
    console.error("Data validation failed:");
    console.error(e.issues.map((issue: z.core.$ZodIssue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n"));
  }
  console.error("FATAL: Could not load required data");
  console.error((e as Error).message);
  process.exit(1);
}

// Load pre-built list search index (built by scripts/build-items.ts)
let listSearch: MiniSearch<AwesomeList>;
try {
  const listSearchData = await loadData({
    filename: "list-search-index.json.gz",
    gzipped: true,
  });
  listSearch = MiniSearch.loadJSON<AwesomeList>(JSON.stringify(listSearchData), {
    fields: ["name", "repo", "description"],
    storeFields: [],
    searchOptions: {
      boost: { name: 2, repo: 1.5, description: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
} catch {
  // Fallback: build index at runtime if pre-built not available
  console.error("Pre-built list search index not found, building at runtime...");
  listSearch = new MiniSearch<AwesomeList>({
    fields: ["name", "repo", "description"],
    storeFields: [],
    searchOptions: {
      boost: { name: 2, repo: 1.5, description: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
  listSearch.addAll(lists.map((list, i) => ({ id: i, ...list })));
}

// Build flat list of all items for global search (needed for ID lookups)
const allItems: IndexedItem[] = [];
let itemId = 0;
for (const [listRepo, entry] of Object.entries(itemsIndex.lists)) {
  for (const item of entry.items) {
    allItems.push({ ...item, id: itemId++, listRepo });
  }
}

// Load pre-built item search index (built by scripts/build-items.ts)
let itemSearch: MiniSearch<IndexedItem>;
try {
  const itemSearchData = await loadData({
    filename: "item-search-index.json.gz",
    gzipped: true,
  });
  itemSearch = MiniSearch.loadJSON<IndexedItem>(JSON.stringify(itemSearchData), {
    fields: ["name", "description", "category"],
    storeFields: [],
    searchOptions: {
      boost: { name: 2, category: 1.5, description: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
} catch {
  // Fallback: build index at runtime if pre-built not available
  console.error("Pre-built item search index not found, building at runtime...");
  itemSearch = new MiniSearch<IndexedItem>({
    fields: ["name", "description", "category"],
    storeFields: [],
    searchOptions: {
      boost: { name: 2, category: 1.5, description: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
  itemSearch.addAll(allItems);
}

console.error(`Loaded ${itemsIndex.itemCount} items from ${itemsIndex.listCount} lists`);

// Create MCP server
const server = new McpServer({
  name: "awess",
  version: "0.3.0",
});

// Tool: Search awesome lists (unified search, top_lists, get_list)
server.tool(
  "search_lists",
  "Search curated awesome lists. Returns lists sorted by relevance (if query provided) or stars.",
  {
    query: z.string().optional().describe("Search query (e.g., 'rust', 'machine learning')"),
    repo: z.string().optional().describe("Exact repo lookup (e.g., 'sindresorhus/awesome')"),
    sortBy: z.enum(["relevance", "stars", "updated"]).optional().describe("Sort order (default: 'stars', or 'relevance' if query provided)"),
    minStars: z.number().int().min(0).optional().describe("Minimum star count filter"),
    limit: z.number().int().min(1).max(CONFIG.search.maxLimit).optional()
      .describe(`Maximum results (default: ${CONFIG.search.defaultListLimit}, max: ${CONFIG.search.maxLimit})`),
    offset: z.number().int().min(0).optional().describe("Skip first N results (for pagination)"),
  },
  async ({ query, repo, sortBy, minStars = 0, limit = CONFIG.search.defaultListLimit, offset = 0 }) => {
    // Exact repo lookup
    if (repo) {
      const list = lists.find(l => l.repo.toLowerCase() === repo.toLowerCase());
      if (!list) {
        return {
          content: [{ type: "text", text: JSON.stringify({ count: 0, items: [] }, null, 2) }],
        };
      }
      const enrichedList = {
        repo: list.repo,
        name: list.name,
        stars: list.stars,
        description: list.description,
        lastUpdated: list.pushed_at,
        source: list.source,
        githubUrl: `https://github.com/${list.repo}`,
      };
      return {
        content: [{ type: "text", text: JSON.stringify({ count: 1, items: [enrichedList] }, null, 2) }],
      };
    }

    // Determine sort order
    const effectiveSortBy = sortBy || (query ? "relevance" : "stars");

    let results: ListResult[];

    if (query && effectiveSortBy === "relevance") {
      // Search with relevance sorting - look up from lists by ID (O(1) since id === array index)
      results = listSearch
        .search(query)
        .map(r => lists[r.id])
        .filter(l => l.stars >= minStars)
        .slice(offset, offset + limit)
        .map(l => ({
          repo: l.repo,
          name: l.name,
          stars: l.stars,
          description: l.description,
          lastUpdated: l.pushed_at,
        }));
    } else {
      // Filter and sort manually
      let filtered = lists.filter(l => l.stars >= minStars);

      if (query) {
        const searchResults = new Set(listSearch.search(query).map(r => lists[r.id].repo));
        filtered = filtered.filter(l => searchResults.has(l.repo));
      }

      // Sort
      if (effectiveSortBy === "updated") {
        filtered.sort((a, b) => (b.pushed_at || "").localeCompare(a.pushed_at || ""));
      } else {
        filtered.sort((a, b) => b.stars - a.stars);
      }

      results = filtered.slice(offset, offset + limit).map(l => ({
        repo: l.repo,
        name: l.name,
        stars: l.stars,
        description: l.description,
        lastUpdated: l.pushed_at,
      }));
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ count: results.length, items: results }, null, 2) }],
    };
  }
);

// Tool: Search items (global search with filters)
server.tool(
  "search_items",
  "Search tools, libraries, and resources across all awesome lists. Supports global search or filtering within a specific list.",
  {
    query: z.string().optional().describe("Search item names/descriptions"),
    repo: z.string().optional().describe("Limit to a specific list (e.g., 'vinta/awesome-python')"),
    category: z.string().optional().describe("Filter by category"),
    language: z.string().optional().describe("Filter by programming language"),
    minStars: z.number().int().min(0).optional().describe("Minimum GitHub stars"),
    sortBy: z.enum(["relevance", "stars", "updated"]).optional().describe("Sort order (default: 'stars', or 'relevance' if query provided)"),
    limit: z.number().int().min(1).max(CONFIG.search.maxLimit).optional()
      .describe(`Maximum results (default: ${CONFIG.search.defaultItemLimit}, max: ${CONFIG.search.maxLimit})`),
    offset: z.number().int().min(0).optional().describe("Skip first N results (for pagination)"),
  },
  async ({ query, repo, category, language, minStars = 0, sortBy, limit = CONFIG.search.defaultItemLimit, offset = 0 }) => {
    const effectiveSortBy = sortBy || (query ? "relevance" : "stars");

    let results: IndexedItem[];

    if (query && effectiveSortBy === "relevance") {
      // Search with relevance - look up from allItems by ID (O(1) since id === array index)
      results = itemSearch.search(query).map(r => allItems[r.id]);
    } else {
      // Start with all items or query results
      if (query) {
        const searchResultIds = new Set(itemSearch.search(query).map(r => r.id));
        results = allItems.filter(i => searchResultIds.has(i.id));
      } else {
        results = [...allItems];
      }
    }

    // Apply all filters in a single pass for better performance
    const repoLower = repo?.toLowerCase();
    const catLower = category?.toLowerCase();
    const langLower = language?.toLowerCase();

    results = results.filter(item => {
      if (repoLower && item.listRepo.toLowerCase() !== repoLower) return false;
      if (catLower) {
        const itemCat = item.category?.toLowerCase() ?? "";
        const itemSubcat = item.subcategory?.toLowerCase() ?? "";
        if (!itemCat.includes(catLower) && !itemSubcat.includes(catLower)) return false;
      }
      if (langLower && (!hasGitHubMetadata(item) || item.github.language?.toLowerCase() !== langLower)) return false;
      if (minStars > 0 && (!hasGitHubMetadata(item) || item.github.stars < minStars)) return false;
      return true;
    });

    // Sort (if not already sorted by relevance)
    if (effectiveSortBy === "stars") {
      results.sort((a, b) => {
        const aStars = hasGitHubMetadata(a) ? a.github.stars : 0;
        const bStars = hasGitHubMetadata(b) ? b.github.stars : 0;
        return bStars - aStars;
      });
    } else if (effectiveSortBy === "updated") {
      results.sort((a, b) => {
        const aDate = hasGitHubMetadata(a) ? a.github.pushedAt : "";
        const bDate = hasGitHubMetadata(b) ? b.github.pushedAt : "";
        return bDate.localeCompare(aDate);
      });
    }

    // Apply offset and limit for pagination
    const limited = results.slice(offset, offset + limit);

    const items = limited.map(i => {
      const gh = hasGitHubMetadata(i) ? i.github : null;
      return {
        name: i.name,
        url: i.url,
        description: i.description,
        category: i.category,
        subcategory: i.subcategory,
        stars: gh?.stars,
        language: gh?.language,
        lastUpdated: gh?.pushedAt,
        list: i.listRepo,
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ count: items.length, items }, null, 2) }],
    };
  }
);

// Tool: Browse categories
server.tool(
  "browse_categories",
  "List available categories with item counts",
  {
    repo: z.string().optional().describe("Filter to categories from specific list"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum categories (default: 50)"),
  },
  async ({ repo, limit = 50 }) => {
    const categoryCounts = new Map<string, number>();

    const items = repo
      ? allItems.filter(i => i.listRepo.toLowerCase() === repo.toLowerCase())
      : allItems;

    for (const item of items) {
      const cat = item.category || "Uncategorized";
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }

    const categories = Array.from(categoryCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: categories.length, categories }, null, 2),
      }],
    };
  }
);

/** Result type for stats computation */
interface StatsResult {
  lists: {
    total: number;
    totalStars: number;
    avgStars: number;
    starDistribution: Record<string, number>;
  };
  items: {
    totalItems: number;
    enrichedItems: number;
    listsWithItems: number;
    topLanguages: Record<string, number>;
    topCategories: Record<string, number>;
  };
}

/** Cache for stats result since data doesn't change during runtime */
let cachedStats: StatsResult | null = null;

/**
 * Compute collection statistics using single-pass algorithms.
 * Results are cached since data is static during server lifetime.
 */
function computeStats(): StatsResult {
  // Star distribution buckets for lists
  const starBuckets: Record<string, number> = {
    "10000+": 0,
    "5000-9999": 0,
    "1000-4999": 0,
    "500-999": 0,
    "<500": 0,
  };

  // Single pass over lists
  let totalStars = 0;
  for (const list of lists) {
    totalStars += list.stars;
    if (list.stars >= 10000) starBuckets["10000+"]++;
    else if (list.stars >= 5000) starBuckets["5000-9999"]++;
    else if (list.stars >= 1000) starBuckets["1000-4999"]++;
    else if (list.stars >= 500) starBuckets["500-999"]++;
    else starBuckets["<500"]++;
  }

  // Single pass over items
  const languageCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  let enrichedCount = 0;

  for (const item of allItems) {
    // Count categories
    if (item.category) {
      categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
    }

    // Count enriched items and languages
    if (hasGitHubMetadata(item)) {
      enrichedCount++;
      if (item.github.language) {
        languageCounts.set(item.github.language, (languageCounts.get(item.github.language) || 0) + 1);
      }
    }
  }

  // Format top languages (top 10 by count)
  const topLanguages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .reduce((acc, [lang, count]) => ({ ...acc, [lang]: count }), {} as Record<string, number>);

  // Format top categories (top 10 by count)
  const topCategories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .reduce((acc, [cat, count]) => ({ ...acc, [cat]: count }), {} as Record<string, number>);

  return {
    lists: {
      total: lists.length,
      totalStars,
      avgStars: Math.round(totalStars / lists.length),
      starDistribution: starBuckets,
    },
    items: {
      totalItems: allItems.length,
      enrichedItems: enrichedCount,
      listsWithItems: itemsIndex.listCount,
      topLanguages,
      topCategories,
    },
  };
}

// Tool: Stats (enhanced with item statistics)
server.tool(
  "stats",
  "Get statistics about the curated awesome lists collection and items",
  {},
  async () => {
    if (!cachedStats) {
      cachedStats = computeStats();
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify(cachedStats, null, 2),
      }],
    };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
