// src/enricher.ts
import type { Item } from "./types";
import { CONFIG } from "./config";

// Regex to validate GitHub owner/repo names - prevents GraphQL injection
// Valid characters: alphanumeric, underscore, hyphen, and dot
const GITHUB_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

export function validateGitHubName(name: string): boolean {
  return GITHUB_NAME_REGEX.test(name);
}

export function extractGitHubRepo(url: string): string | null {
  const match = url.match(/github\.com\/([^\/]+\/[^\/]+)/);
  if (!match) return null;

  // Clean up repo name: remove .git, #readme, query params, etc.
  let repo = match[1]
    .replace(/\.git$/, "")
    .replace(/#.*$/, "")
    .replace(/\?.*$/, "");

  // Skip non-repo paths like "topics/awesome", "sponsors/foo"
  const invalidPrefixes = ["topics", "sponsors", "orgs", "settings", "marketplace"];
  if (invalidPrefixes.some(p => repo.startsWith(p + "/"))) {
    return null;
  }

  return repo;
}

// Sleep helper with jitter
function sleep(ms: number, jitter = 0.2): Promise<void> {
  const jitterMs = ms * jitter * (Math.random() - 0.5) * 2;
  return new Promise(resolve => setTimeout(resolve, ms + jitterMs));
}

export async function batchEnrichItems(items: Item[]): Promise<Item[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("No GITHUB_TOKEN - skipping enrichment");
    return items;
  }

  // Extract unique GitHub repos
  const repoMap = new Map<string, Item[]>();
  for (const item of items) {
    const repo = extractGitHubRepo(item.url);
    if (repo) {
      if (!repoMap.has(repo)) repoMap.set(repo, []);
      repoMap.get(repo)!.push(item);
    }
  }

  const repos = Array.from(repoMap.keys());
  console.log(`Enriching ${repos.length} unique repos...`);

  // Tuned for GitHub's secondary rate limits
  const batchSize = CONFIG.github.batchSize;
  const baseDelayMs = CONFIG.github.baseDelayMs;
  let currentDelay: number = baseDelayMs;
  let consecutiveErrors = 0;
  let batchRetryCount = 0;

  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(repos.length / batchSize);

    // Add delay between batches (except first)
    if (i > 0) {
      await sleep(currentDelay);
    }

    // Include rateLimit in query to monitor usage
    // Build repo queries with validation to prevent GraphQL injection
    // Track which repos were actually queried to fix index alignment
    const queriedRepos: string[] = [];
    const repoQueries = batch.map((repo) => {
      const [owner, name] = repo.split("/");
      if (!validateGitHubName(owner) || !validateGitHubName(name)) {
        console.warn(`Invalid repo name, skipping: ${repo}`);
        return null;
      }
      const queryIdx = queriedRepos.length;
      queriedRepos.push(repo);
      return `repo${queryIdx}: repository(owner: "${owner}", name: "${name}") {
        stargazerCount
        primaryLanguage { name }
        pushedAt
      }`;
    }).filter((q): q is string => q !== null);

    // Skip batch if all repos were invalid
    if (repoQueries.length === 0) {
      console.log(`  [${batchNum}/${totalBatches}] All repos in batch invalid, skipping`);
      continue;
    }

    const query = `
      query {
        rateLimit { cost remaining resetAt }
        ${repoQueries.join("\n")}
      }
    `;

    try {
      // Use fetch instead of octokit.graphql to handle partial results
      const response = await fetch(CONFIG.github.graphqlEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(CONFIG.network.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json: any = await response.json();

      // Check for complete failure (errors but no data)
      if (json.errors && !json.data) {
        throw new Error(json.errors[0]?.message || "GraphQL query failed");
      }

      // Track repos that don't exist (from GraphQL errors)
      const notFoundRepos = new Set<string>();
      if (json.errors) {
        for (const error of json.errors) {
          if (error.path?.[0]?.startsWith("repo")) {
            const idx = parseInt(error.path[0].slice(4));
            if (queriedRepos[idx]) {
              notFoundRepos.add(queriedRepos[idx]);
            }
          }
        }
        if (notFoundRepos.size > 0) {
          console.log(`  [${batchNum}/${totalBatches}] ${notFoundRepos.size} repos not found`);
        }
      }

      const result = json.data;

      // Log rate limit status periodically
      const rl = result.rateLimit;
      if (batchNum % 10 === 0 || rl?.remaining < 100) {
        console.log(`  [${batchNum}/${totalBatches}] Rate limit: ${rl?.remaining} remaining, cost: ${rl?.cost}`);
      } else {
        process.stdout.write(`  [${batchNum}/${totalBatches}]\r`);
      }

      // If running low on points, slow down
      if (rl?.remaining < 500) {
        currentDelay = Math.min(currentDelay * 1.5, 5000);
        console.log(`  ⚠️ Low rate limit (${rl.remaining}), increasing delay to ${currentDelay}ms`);
      }

      // Process results - use queriedRepos to align indices correctly
      const now = new Date().toISOString();
      for (let j = 0; j < queriedRepos.length; j++) {
        const repo = queriedRepos[j];
        const data = result[`repo${j}`];
        const itemsForRepo = repoMap.get(repo)!;

        if (data) {
          // Repo exists - update metadata
          for (const item of itemsForRepo) {
            item.github = {
              stars: data.stargazerCount,
              language: data.primaryLanguage?.name || null,
              pushedAt: data.pushedAt,
            };
            item.lastEnriched = now;
          }
        } else if (notFoundRepos.has(repo)) {
          // Repo explicitly not found via GraphQL error - mark as dead
          for (const item of itemsForRepo) {
            item.github = { notFound: true, checkedAt: now };
            item.lastEnriched = now;
          }
        } else {
          // Unknown state - null without explicit error
          // Don't update - leave for next enrichment cycle
          console.warn(`Repo ${repo} returned null without error, leaving for recheck`);
        }
      }

      // Reset on success
      consecutiveErrors = 0;
      batchRetryCount = 0;
      currentDelay = Math.max(currentDelay * 0.9, baseDelayMs); // Gradually speed up

    } catch (error: any) {
      consecutiveErrors++;

      // Check for secondary rate limit
      const isRateLimitError = error.message?.includes("SecondaryRateLimit") || error.message?.includes("403");
      if (isRateLimitError && batchRetryCount < CONFIG.github.maxRetries) {
        batchRetryCount++;
        // Exponential backoff with jitter
        const backoffMs = Math.min(baseDelayMs * Math.pow(2, consecutiveErrors), CONFIG.github.maxBackoffMs);
        console.warn(`  Rate limited, retry ${batchRetryCount}/${CONFIG.github.maxRetries}, backing off for ${backoffMs}ms...`);
        await sleep(backoffMs, 0.3);
        currentDelay = backoffMs; // Keep the higher delay
        i -= batchSize; // Retry this batch
        continue;
      } else if (isRateLimitError) {
        console.error(`  Rate limit exceeded ${CONFIG.github.maxRetries} retries, skipping batch ${batchNum}`);
        batchRetryCount = 0; // Reset for next batch
        // Don't retry - let the loop continue to next batch
        continue;
      }

      // Log other errors but continue
      console.error(`  Error batch ${batchNum}: ${error.message?.slice(0, 100)}`);

      // If too many consecutive errors, slow down
      if (consecutiveErrors >= 3) {
        currentDelay = Math.min(currentDelay * 2, CONFIG.github.maxDelayMs);
        console.log(`  Multiple errors, slowing to ${currentDelay}ms`);
      }
    }
  }

  console.log(""); // Clear the \r line
  return items;
}

export async function batchQueryListRepos(
  repos: string[]
): Promise<Map<string, { pushedAt: string } | null>> {
  const results = new Map<string, { pushedAt: string } | null>();

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("No GITHUB_TOKEN - skipping list repo query");
    return results;
  }

  const BATCH_SIZE = CONFIG.github.batchSize;

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(repos.length / BATCH_SIZE);
    process.stdout.write(`  [${batchNum}/${totalBatches}]\r`);

    // Build GraphQL query for this batch with validation to prevent GraphQL injection
    // Track which repos were actually queried to fix index alignment
    const queriedRepos: string[] = [];
    const repoQueries = batch.map((repo) => {
      const [owner, name] = repo.split("/");
      if (!validateGitHubName(owner) || !validateGitHubName(name)) {
        console.warn(`Invalid repo name, skipping: ${repo}`);
        return null;
      }
      const queryIdx = queriedRepos.length;
      queriedRepos.push(repo);
      return `repo${queryIdx}: repository(owner: "${owner}", name: "${name}") {
        pushedAt
      }`;
    }).filter((q): q is string => q !== null);

    // Skip batch if all repos were invalid
    if (repoQueries.length === 0) {
      console.log(`  [${batchNum}/${totalBatches}] All repos in batch invalid, skipping`);
      // Mark all as null since we can't query them
      for (const repo of batch) {
        results.set(repo, null);
      }
      continue;
    }

    const query = `query { ${repoQueries.join("\n")} }`;

    try {
      const response = await fetch(CONFIG.github.graphqlEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(CONFIG.network.timeout),
      });

      if (!response.ok) {
        console.error(`  Error batch ${batchNum}: HTTP ${response.status}`);
        for (const repo of batch) {
          results.set(repo, null);
        }
        continue;
      }

      const json = await response.json();

      if (json.errors && !json.data) {
        console.error(`  Error batch ${batchNum}:`, json.errors[0]?.message);
        // Mark all repos in batch as null
        for (const repo of batch) {
          results.set(repo, null);
        }
        continue;
      }

      // Track repos that don't exist (from GraphQL errors)
      const notFoundRepos = new Set<string>();
      if (json.errors) {
        for (const error of json.errors) {
          if (error.path?.[0]?.startsWith("repo")) {
            const idx = parseInt(error.path[0].slice(4));
            if (queriedRepos[idx]) {
              notFoundRepos.add(queriedRepos[idx]);
            }
          }
        }
      }

      // Extract results - use queriedRepos to align indices correctly
      queriedRepos.forEach((repo, idx) => {
        const data = json.data?.[`repo${idx}`];
        if (data?.pushedAt) {
          results.set(repo, { pushedAt: data.pushedAt });
        } else if (notFoundRepos.has(repo)) {
          // Explicitly not found - set to null
          results.set(repo, null);
        } else {
          // Unknown state - null without explicit error, leave for recheck
          console.warn(`Repo ${repo} returned null without error in list query, leaving for recheck`);
          results.set(repo, null);
        }
      });
      // Mark invalid repos (not in queriedRepos) as null
      for (const repo of batch) {
        if (!results.has(repo)) {
          results.set(repo, null);
        }
      }
    } catch (error: any) {
      console.error(`  Error batch ${batchNum}:`, error.message);
      for (const repo of batch) {
        results.set(repo, null);
      }
    }
  }

  console.log(); // newline after progress
  return results;
}
