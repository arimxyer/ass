// src/types.ts
import { z } from "zod";

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if github metadata is valid (not notFound).
 * Use this to narrow Item["github"] to GitHubMetadata.
 */
export function hasGitHubMetadata<T extends { github?: Item["github"] }>(
  item: T
): item is T & { github: GitHubMetadata } {
  return item.github !== undefined && !("notFound" in item.github);
}

// ============================================================================
// Core Interfaces
// ============================================================================

export interface GitHubMetadata {
  stars: number;
  language: string | null;
  pushedAt: string;
}

export interface GitHubNotFound {
  notFound: true;
  checkedAt: string;
}

export interface Item {
  name: string;
  url: string;
  description: string;
  category: string;
  subcategory?: string;
  lastEnriched?: string;
  github?: GitHubMetadata | GitHubNotFound;
}

export interface ListEntry {
  lastParsed: string;
  pushedAt: string;
  items: Item[];
}

export interface ItemsIndex {
  generatedAt: string;
  listCount: number;
  itemCount: number;
  lists: Record<string, ListEntry>;
}

export interface DiffResult {
  added: Item[];
  removed: Item[];
  unchanged: Item[];
  updated: Item[];
}

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

/** Schema for awesome list entries in lists.json */
export const AwesomeListSchema = z.object({
  repo: z.string(),
  name: z.string(),
  stars: z.number(),
  description: z.string(),
  source: z.string(),
  pushed_at: z.string().optional(),
});

export type AwesomeList = z.infer<typeof AwesomeListSchema>;

/** Schema for GitHub metadata on enriched items */
export const GitHubMetadataSchema = z.object({
  stars: z.number(),
  language: z.string().nullable(),
  pushedAt: z.string(),
});

/** Schema for items where GitHub repo was not found */
export const GitHubNotFoundSchema = z.object({
  notFound: z.literal(true),
  checkedAt: z.string(),
});

/** Schema for a single item in an awesome list */
export const ItemSchema = z.object({
  name: z.string(),
  url: z.string(),
  description: z.string(),
  category: z.string(),
  subcategory: z.string().optional(),
  lastEnriched: z.string().optional(),
  github: z.union([GitHubMetadataSchema, GitHubNotFoundSchema]).optional(),
});

/** Schema for a list entry in the items index */
export const ListEntrySchema = z.object({
  lastParsed: z.string(),
  pushedAt: z.string(),
  items: z.array(ItemSchema),
});

/** Schema for the full items index */
export const ItemsIndexSchema = z.object({
  generatedAt: z.string(),
  listCount: z.number(),
  itemCount: z.number(),
  lists: z.record(z.string(), ListEntrySchema),
});

// ============================================================================
// GraphQL Response Types
// ============================================================================

/** Structure of a single repo in GraphQL response */
export interface GraphQLRepoData {
  stargazerCount: number;
  primaryLanguage?: { name: string } | null;
  pushedAt: string;
}

/** Structure of GraphQL rate limit info */
export interface GraphQLRateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
}

/** Structure of GraphQL error */
export interface GraphQLError {
  message: string;
  path?: string[];
}

/** Full GraphQL response from GitHub API */
export interface GraphQLResponse {
  data?: {
    rateLimit?: GraphQLRateLimit;
    [key: `repo${number}`]: GraphQLRepoData | null;
  };
  errors?: GraphQLError[];
}
