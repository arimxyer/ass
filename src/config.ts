// src/config.ts
// Centralized configuration for all magic numbers and constants

export const CONFIG = {
  network: {
    /** Request timeout in milliseconds */
    timeout: 15000,
    cdnUrls: {
      /** Primary CDN - jsDelivr (faster, global CDN) */
      jsdelivr: "https://cdn.jsdelivr.net/gh/arimxyer/ass@main/data",
      /** Fallback CDN - GitHub raw content */
      githubRaw: "https://raw.githubusercontent.com/arimxyer/ass/main/data",
    },
  },

  github: {
    /** GitHub GraphQL API endpoint */
    graphqlEndpoint: "https://api.github.com/graphql",
    /** Number of repos to query per GraphQL batch */
    batchSize: 50,
    /** Base delay between batches in milliseconds */
    baseDelayMs: 500,
    /** Maximum delay after rate limit hit */
    maxDelayMs: 10000,
    /** Maximum exponential backoff for secondary rate limits */
    maxBackoffMs: 60000,
    /** Start slowing down when remaining points below this */
    lowRateLimitThreshold: 500,
    /** Log warning when remaining points below this */
    criticalRateLimitThreshold: 100,
    /** Maximum retries per batch before giving up */
    maxRetries: 3,
    /** Log rate limit status every N batches */
    logFrequency: 10,
  },

  search: {
    /** Default limit for search_lists results */
    defaultListLimit: 20,
    /** Default limit for search_items results */
    defaultItemLimit: 50,
    /** Maximum allowed limit for any search */
    maxLimit: 500,
    /** Fuzzy search threshold (0 = exact, 1 = very fuzzy) */
    fuzzyThreshold: 0.2,
  },

  build: {
    /** Number of oldest items to re-check for staleness each run */
    recheckBatchSize: 1000,
    /** Number of concurrent README fetches */
    fetchConcurrency: 20,
    /** Fail build if more than this percentage of lists fail */
    failureThreshold: 0.1,
  },
} as const;

// Type for the config object
export type Config = typeof CONFIG;
