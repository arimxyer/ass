# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**awess** (Awesome Search Services) is an MCP server that provides searchable access to 631+ curated awesome lists and 164,000+ tools/libraries within them. It runs via `bunx awess` and exposes tools for searching lists, browsing items, and fetching GitHub metadata.

## Commands

```bash
bun install          # Install dependencies
bun run start        # Run MCP server
bun run dev          # Run with --watch for development
bun test             # Run all tests
bun test src/parser.test.ts  # Run single test file
```

### Build Script

```bash
GITHUB_TOKEN=xxx bun scripts/build-items.ts
```

Fetches READMEs from all awesome lists, parses them, enriches with GitHub metadata, and writes `data/items.json`. Uses incremental enrichment (7-day cache) to avoid re-fetching.

## Architecture

### Data Flow

1. **`data/lists.json`** - Source list of 631 awesome repos (repo, name, stars)
2. **`scripts/build-items.ts`** - Fetches READMEs, parses items, enriches with GitHub data
3. **`data/items.json`** - Generated index (~42MB) with 164k items and their metadata
4. **`src/index.ts`** - MCP server loads data from CDN (falls back to local), builds MiniSearch index

### Core Modules

- **`src/parser.ts`** - Parses awesome list READMEs using mdast. Extracts items from markdown list items, tracking h2 as categories and h3 as subcategories.

- **`src/enricher.ts`** - Batch enriches items with GitHub metadata via GraphQL API. Handles rate limiting with exponential backoff.

- **`src/types.ts`** - Shared types (`Item`, `ListEntry`, `ItemsIndex`). Hub file imported by all other modules.

### MCP Tools

The server exposes 3 tools:

- **`search_lists`** - Search/browse awesome lists by query, get by repo, filter by stars, sort by relevance/stars/updated
- **`search_items`** - Search tools/libraries across all lists with filters (repo, category, language, minStars)
- **`stats`** - Get collection statistics (list counts, star distribution, top languages/categories)

### Data Loading

The server tries jsDelivr CDN first, falls back to GitHub raw, then local `data/` directory for development.
