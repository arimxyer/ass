# Awesome Search Services

MCP server for searching 631+ curated awesome lists and 177,000+ tools/libraries within them.

## Features

- **Search lists** - Find awesome lists by keyword (e.g., "machine learning", "rust")
- **Global item search** - Search across ALL 177k items, not just within one list
- **Filter by language** - Find Python, Rust, Go projects, etc.
- **GitHub metadata** - Star counts, languages, last updated
- **Fast CDN delivery** - Data served via jsDelivr (~1s load time)

## Quick Start

### Claude Code

```bash
claude mcp add awess -- bunx awess@latest
```

### Claude Desktop

Add to your config file:

```json
{
  "mcpServers": {
    "awess": {
      "command": "bunx",
      "args": ["awess"]
    }
  }
}
```

**Config locations:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

### Run directly

```bash
bunx awess@latest
```

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector bunx awess@latest
```

## Tools

### search_lists

Search curated awesome lists. Returns lists sorted by relevance (if query provided) or stars.

**Parameters:**
- `query` (optional): Search query (e.g., "rust", "machine learning")
- `repo` (optional): Exact repo lookup (e.g., "sindresorhus/awesome")
- `sortBy` (optional): "relevance" | "stars" | "updated" (default: "stars", or "relevance" if query provided)
- `minStars` (optional): Minimum star count filter
- `limit` (optional): Maximum results (default: 20)
- `offset` (optional): Skip first N results (for pagination)

**Examples:**
```json
// Search for rust lists
{ "query": "rust", "limit": 5 }

// Get top lists by stars
{ "sortBy": "stars", "limit": 10 }

// Lookup specific list
{ "repo": "sindresorhus/awesome" }

// Recently updated lists
{ "sortBy": "updated", "minStars": 5000 }
```

### search_items

Search tools, libraries, and resources across all awesome lists. Supports global search or filtering within a specific list.

**Parameters:**
- `query` (optional): Search item names/descriptions
- `repo` (optional): Limit to a specific list (e.g., "vinta/awesome-python")
- `category` (optional): Filter by category
- `language` (optional): Filter by programming language
- `minStars` (optional): Minimum GitHub stars
- `sortBy` (optional): "relevance" | "stars" | "updated" (default: "stars", or "relevance" if query provided)
- `limit` (optional): Maximum results (default: 50)
- `offset` (optional): Skip first N results (for pagination)

**Examples:**
```json
// Find all GraphQL libraries across all lists
{ "query": "graphql", "minStars": 1000 }

// Find Rust projects with 10k+ stars
{ "language": "rust", "minStars": 10000 }

// Browse items from a specific list
{ "repo": "vinta/awesome-python", "category": "Web Frameworks" }

// Top items by stars globally
{ "sortBy": "stars", "limit": 20 }
```

### browse_categories

List available categories with item counts.

**Parameters:**
- `repo` (optional): Filter to categories from a specific list
- `limit` (optional): Maximum categories (default: 50)

**Examples:**
```json
// Get top categories across all lists
{ "limit": 20 }

// Categories from a specific list
{ "repo": "vinta/awesome-python" }
```

### stats

Get statistics about the curated awesome lists collection and items.

**Parameters:** None

**Returns:**
```json
{
  "lists": {
    "total": 631,
    "totalStars": 6671565,
    "avgStars": 10573,
    "starDistribution": { "10000+": 102, "5000-9999": 77, ... }
  },
  "items": {
    "totalItems": 177803,
    "enrichedItems": 84083,
    "listsWithItems": 626,
    "topLanguages": { "Python": 15193, "TypeScript": 6221, ... },
    "topCategories": { "Papers": 4923, "Tools": 3241, ... }
  }
}
```

## Development

```bash
git clone https://github.com/arimxyer/ass.git
cd ass
bun install
bun run start
```

### Build items index

```bash
GITHUB_TOKEN=xxx bun scripts/build-items.ts
```

Fetches READMEs from all awesome lists, parses items, enriches with GitHub metadata, and writes `data/items.json.gz`.

## License

MIT
