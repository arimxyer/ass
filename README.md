# Awesome Search Services

MCP server for searching 631+ curated awesome lists and 164,000+ tools/libraries within them.

## Features

- **Search lists** - Find awesome lists by keyword (e.g., "machine learning", "rust")
- **Browse items** - Get tools/libraries from within any list
- **GitHub metadata** - Star counts, languages, last updated
- **Zero setup** - Data loaded from CDN, no cloning required

## Quick Start

### Claude Code

```bash
claude mcp add ass -- bunx ass
```

### Claude Desktop

Add to your config file:

```json
{
  "mcpServers": {
    "ass": {
      "command": "bunx",
      "args": ["ass"]
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
bunx ass
```

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector bunx ass
```

## Development

```bash
git clone https://github.com/arimxyer/ass.git
cd ass
bun install
bun run start
```

## Tools

### search

Search curated awesome lists by keyword. Returns matching lists sorted by relevance and stars.

**Parameters:**
- `query` (required): Search query (e.g., "rust", "machine learning", "react")
- `limit` (optional): Maximum results to return (default: 10)
- `minStars` (optional): Minimum star count filter (default: 0)

**Example:**
```json
{
  "query": "machine learning",
  "limit": 5,
  "minStars": 1000
}
```

### get_list

Get details for a specific awesome list by repository name.

**Parameters:**
- `repo` (required): Repository name (e.g., "sindresorhus/awesome")

**Example:**
```json
{
  "repo": "sindresorhus/awesome"
}
```

### top_lists

Get top awesome lists by star count.

**Parameters:**
- `limit` (optional): Number of lists to return (default: 20)
- `category` (optional): Optional keyword to filter by (e.g., "python", "web")

**Example:**
```json
{
  "limit": 10,
  "category": "python"
}
```

### stats

Get statistics about the curated awesome lists collection.

**Parameters:** None

**Example:**
```json
{}
```

### get_items

Get resources/items from an awesome list.

**Parameters:**
- `repo` (required): Repository name (e.g., "vinta/awesome-python")
- `category` (optional): Filter by category/section name
- `limit` (optional): Maximum items to return (default: 50)

**Example:**
```json
{
  "repo": "vinta/awesome-python",
  "category": "Web Frameworks",
  "limit": 10
}
```

## License

MIT
