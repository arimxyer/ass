import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import MiniSearch from "minisearch";
import { z } from "zod";

interface AwesomeList {
  repo: string;
  name: string;
  stars: number;
  description: string;
  pushed_at?: string;
  source: string;
}

// Load curated data
const dataPath = new URL("../data/lists.json", import.meta.url);
const lists: AwesomeList[] = await Bun.file(dataPath).json();

// Initialize search index
const search = new MiniSearch<AwesomeList>({
  fields: ["name", "repo", "description"],
  storeFields: ["repo", "name", "stars", "description", "pushed_at", "source"],
  searchOptions: {
    boost: { name: 2, repo: 1.5, description: 1 },
    fuzzy: 0.2,
    prefix: true,
  },
});

// Index all lists with repo as id
search.addAll(lists.map((list, i) => ({ id: i, ...list })));

// Create MCP server
const server = new McpServer({
  name: "ass",
  version: "0.1.0",
});

// Tool: Search awesome lists
server.tool(
  "search",
  "Search curated awesome lists by keyword. Returns matching lists sorted by relevance and stars.",
  {
    query: z.string().describe("Search query (e.g., 'rust', 'machine learning', 'react')"),
    limit: z.number().optional().describe("Maximum results to return (default: 10)"),
    minStars: z.number().optional().describe("Minimum star count filter (default: 0)"),
  },
  async ({ query, limit = 10, minStars = 0 }) => {
    const results = search
      .search(query)
      .filter((r) => r.stars >= minStars)
      .slice(0, limit)
      .map((r) => ({
        repo: r.repo,
        name: r.name,
        stars: r.stars,
        description: r.description,
        lastUpdated: r.pushed_at,
        score: r.score,
      }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }
);

// Tool: Get list details
server.tool(
  "get_list",
  "Get details for a specific awesome list by repository name",
  {
    repo: z.string().describe("Repository name (e.g., 'sindresorhus/awesome')"),
  },
  async ({ repo }) => {
    const list = lists.find(
      (l) => l.repo.toLowerCase() === repo.toLowerCase()
    );

    if (!list) {
      return {
        content: [
          {
            type: "text",
            text: `List not found: ${repo}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              repo: list.repo,
              name: list.name,
              stars: list.stars,
              description: list.description,
              lastUpdated: list.pushed_at,
              source: list.source,
              githubUrl: `https://github.com/${list.repo}`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: List top repos by stars
server.tool(
  "top_lists",
  "Get top awesome lists by star count",
  {
    limit: z.number().optional().describe("Number of lists to return (default: 20)"),
    category: z.string().optional().describe("Optional keyword to filter by (e.g., 'python', 'web')"),
  },
  async ({ limit = 20, category }) => {
    let filtered = lists;

    if (category) {
      const categoryResults = search.search(category);
      filtered = categoryResults.map((r) => ({
        repo: r.repo,
        name: r.name,
        stars: r.stars,
        description: r.description,
        pushed_at: r.pushed_at,
        source: r.source,
      }));
    }

    const top = filtered
      .sort((a, b) => b.stars - a.stars)
      .slice(0, limit)
      .map((l) => ({
        repo: l.repo,
        name: l.name,
        stars: l.stars,
        description: l.description?.slice(0, 100),
      }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(top, null, 2),
        },
      ],
    };
  }
);

// Tool: Stats
server.tool(
  "stats",
  "Get statistics about the curated awesome lists collection",
  {},
  async () => {
    const totalLists = lists.length;
    const totalStars = lists.reduce((sum, l) => sum + l.stars, 0);
    const avgStars = Math.round(totalStars / totalLists);

    const starBrackets = {
      "10000+": lists.filter((l) => l.stars >= 10000).length,
      "5000-9999": lists.filter((l) => l.stars >= 5000 && l.stars < 10000)
        .length,
      "1000-4999": lists.filter((l) => l.stars >= 1000 && l.stars < 5000)
        .length,
      "500-999": lists.filter((l) => l.stars >= 500 && l.stars < 1000).length,
      "<500": lists.filter((l) => l.stars < 500).length,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              totalLists,
              totalStars,
              avgStars,
              starDistribution: starBrackets,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
