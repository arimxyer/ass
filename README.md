# ASS - Awesome Search Services

MCP server for searching curated awesome lists.

## Features

- 631+ curated awesome lists (500+ stars, updated within last year)
- Fuzzy search with MiniSearch
- Get detailed metadata for individual lists
- Browse items/resources within lists
- Bun runtime

## Installation

```bash
bun install
```

## Usage

```bash
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
