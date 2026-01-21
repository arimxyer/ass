#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import MiniSearch from "minisearch";
import { z } from "zod";
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
  console.error("FATAL: Could not load required data");
  console.error((e as Error).message);
  process.exit(1);
}

// Initialize list search index
const listSearch = new MiniSearch<AwesomeList>({
  fields: ["name", "repo", "description"],
  storeFields: ["repo", "name", "stars", "description", "pushed_at", "source"],
  searchOptions: {
    boost: { name: 2, repo: 1.5, description: 1 },
    fuzzy: 0.2,
    prefix: true,
  },
});

// Index all lists
listSearch.addAll(lists.map((list, i) => ({ id: i, ...list })));

// Build flat list of all items for global search
const allItems: IndexedItem[] = [];
let itemId = 0;
for (const [listRepo, entry] of Object.entries(itemsIndex.lists)) {
  for (const item of entry.items) {
    allItems.push({ ...item, id: itemId++, listRepo });
  }
}

// Initialize item search index
const itemSearch = new MiniSearch<IndexedItem>({
  fields: ["name", "description", "category"],
  storeFields: ["name", "url", "description", "category", "subcategory", "github", "listRepo"],
  searchOptions: {
    boost: { name: 2, category: 1.5, description: 1 },
    fuzzy: 0.2,
    prefix: true,
  },
});

itemSearch.addAll(allItems);

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
    minStars: z.number().optional().describe("Minimum star count filter"),
    limit: z.number().optional().describe("Maximum results (default: 20)"),
  },
  async ({ query, repo, sortBy, minStars = 0, limit = 20 }) => {
    // Exact repo lookup
    if (repo) {
      const list = lists.find(l => l.repo.toLowerCase() === repo.toLowerCase());
      if (!list) {
        return {
          content: [{ type: "text", text: `List not found: ${repo}` }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            repo: list.repo,
            name: list.name,
            stars: list.stars,
            description: list.description,
            lastUpdated: list.pushed_at,
            source: list.source,
            githubUrl: `https://github.com/${list.repo}`,
          }, null, 2),
        }],
      };
    }

    // Determine sort order
    const effectiveSortBy = sortBy || (query ? "relevance" : "stars");

    let results: any[];

    if (query && effectiveSortBy === "relevance") {
      // Search with relevance sorting
      results = listSearch
        .search(query)
        .filter(r => r.stars >= minStars)
        .slice(0, limit)
        .map(r => ({
          repo: r.repo,
          name: r.name,
          stars: r.stars,
          description: r.description,
          lastUpdated: r.pushed_at,
        }));
    } else {
      // Filter and sort manually
      let filtered = lists.filter(l => l.stars >= minStars);

      if (query) {
        const searchResults = new Set(listSearch.search(query).map(r => r.repo));
        filtered = filtered.filter(l => searchResults.has(l.repo));
      }

      // Sort
      if (effectiveSortBy === "updated") {
        filtered.sort((a, b) => (b.pushed_at || "").localeCompare(a.pushed_at || ""));
      } else {
        filtered.sort((a, b) => b.stars - a.stars);
      }

      results = filtered.slice(0, limit).map(l => ({
        repo: l.repo,
        name: l.name,
        stars: l.stars,
        description: l.description,
        lastUpdated: l.pushed_at,
      }));
    }

    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
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
    minStars: z.number().optional().describe("Minimum GitHub stars"),
    sortBy: z.enum(["relevance", "stars", "updated"]).optional().describe("Sort order (default: 'stars', or 'relevance' if query provided)"),
    limit: z.number().optional().describe("Maximum results (default: 50)"),
  },
  async ({ query, repo, category, language, minStars = 0, sortBy, limit = 50 }) => {
    const effectiveSortBy = sortBy || (query ? "relevance" : "stars");

    let results: IndexedItem[];

    if (query && effectiveSortBy === "relevance") {
      // Search with relevance
      results = itemSearch.search(query).map(r => ({
        id: r.id,
        name: r.name,
        url: r.url,
        description: r.description,
        category: r.category,
        subcategory: r.subcategory,
        github: r.github,
        listRepo: r.listRepo,
      })) as IndexedItem[];
    } else {
      // Start with all items or query results
      if (query) {
        const searchResultIds = new Set(itemSearch.search(query).map(r => r.id));
        results = allItems.filter(i => searchResultIds.has(i.id));
      } else {
        results = [...allItems];
      }
    }

    // Apply filters
    if (repo) {
      const repoLower = repo.toLowerCase();
      results = results.filter(i => i.listRepo.toLowerCase() === repoLower);
    }

    if (category) {
      const catLower = category.toLowerCase();
      results = results.filter(i =>
        i.category?.toLowerCase().includes(catLower) ||
        i.subcategory?.toLowerCase().includes(catLower)
      );
    }

    if (language) {
      const langLower = language.toLowerCase();
      results = results.filter(i =>
        hasGitHubMetadata(i) && i.github.language?.toLowerCase() === langLower
      );
    }

    if (minStars > 0) {
      results = results.filter(i => hasGitHubMetadata(i) && i.github.stars >= minStars);
    }

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

    // Apply limit and format
    const limited = results.slice(0, limit);

    const output = {
      totalMatches: results.length,
      returned: limited.length,
      items: limited.map(i => {
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
      }),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    };
  }
);

// Tool: Stats (enhanced with item statistics)
server.tool(
  "stats",
  "Get statistics about the curated awesome lists collection and items",
  {},
  async () => {
    const totalLists = lists.length;
    const totalStars = lists.reduce((sum, l) => sum + l.stars, 0);
    const avgStars = Math.round(totalStars / totalLists);

    const listStarBrackets = {
      "10000+": lists.filter(l => l.stars >= 10000).length,
      "5000-9999": lists.filter(l => l.stars >= 5000 && l.stars < 10000).length,
      "1000-4999": lists.filter(l => l.stars >= 1000 && l.stars < 5000).length,
      "500-999": lists.filter(l => l.stars >= 500 && l.stars < 1000).length,
      "<500": lists.filter(l => l.stars < 500).length,
    };

    // Item statistics
    const enrichedItems = allItems.filter(hasGitHubMetadata);

    // Count languages
    const languageCounts = new Map<string, number>();
    for (const item of enrichedItems) {
      const lang = item.github.language;
      if (lang) {
        languageCounts.set(lang, (languageCounts.get(lang) || 0) + 1);
      }
    }
    const topLanguages = [...languageCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce((acc, [lang, count]) => ({ ...acc, [lang]: count }), {});

    // Count categories
    const categoryCounts = new Map<string, number>();
    for (const item of allItems) {
      if (item.category) {
        categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
      }
    }
    const topCategories = [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce((acc, [cat, count]) => ({ ...acc, [cat]: count }), {});

    const itemStats = {
      totalItems: allItems.length,
      enrichedItems: enrichedItems.length,
      listsWithItems: itemsIndex.listCount,
      topLanguages,
      topCategories,
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          lists: {
            total: totalLists,
            totalStars,
            avgStars,
            starDistribution: listStarBrackets,
          },
          items: itemStats,
        }, null, 2),
      }],
    };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
