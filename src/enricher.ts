// src/enricher.ts
import type { Item } from "./types";

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
  const batchSize = 50;        // Smaller batches = lower query cost
  const baseDelayMs = 500;     // Base delay between batches
  let currentDelay = baseDelayMs;
  let consecutiveErrors = 0;

  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(repos.length / batchSize);

    // Add delay between batches (except first)
    if (i > 0) {
      await sleep(currentDelay);
    }

    // Include rateLimit in query to monitor usage
    const query = `
      query {
        rateLimit { cost remaining resetAt }
        ${batch.map((repo, idx) => {
          const [owner, name] = repo.split("/");
          return `repo${idx}: repository(owner: "${owner}", name: "${name}") {
            stargazerCount
            primaryLanguage { name }
            pushedAt
          }`;
        }).join("\n")}
      }
    `;

    try {
      // Use fetch instead of octokit.graphql to handle partial results
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json: any = await response.json();

      // Check for complete failure (errors but no data)
      if (json.errors && !json.data) {
        throw new Error(json.errors[0]?.message || "GraphQL query failed");
      }

      // Log any partial errors (repos that don't exist, etc.)
      if (json.errors) {
        const failedRepos = json.errors
          .filter((e: any) => e.path?.[0]?.startsWith("repo"))
          .map((e: any) => batch[parseInt(e.path[0].slice(4))])
          .filter(Boolean);
        if (failedRepos.length > 0) {
          console.log(`  [${batchNum}/${totalBatches}] ${failedRepos.length} repos not found`);
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

      // Process results - now handles partial data correctly
      for (let j = 0; j < batch.length; j++) {
        const data = result[`repo${j}`];
        if (data) {
          const itemsForRepo = repoMap.get(batch[j])!;
          for (const item of itemsForRepo) {
            item.github = {
              stars: data.stargazerCount,
              language: data.primaryLanguage?.name || null,
              pushedAt: data.pushedAt,
            };
            item.lastEnriched = new Date().toISOString();
          }
        }
      }

      // Reset on success
      consecutiveErrors = 0;
      currentDelay = Math.max(currentDelay * 0.9, baseDelayMs); // Gradually speed up

    } catch (error: any) {
      consecutiveErrors++;

      // Check for secondary rate limit
      if (error.message?.includes("SecondaryRateLimit") || error.message?.includes("403")) {
        // Exponential backoff with jitter
        const backoffMs = Math.min(baseDelayMs * Math.pow(2, consecutiveErrors), 60000);
        console.log(`  ⚠️ Secondary rate limit hit, backing off for ${backoffMs}ms...`);
        await sleep(backoffMs, 0.3);
        currentDelay = backoffMs; // Keep the higher delay
        i -= batchSize; // Retry this batch
        continue;
      }

      // Log other errors but continue
      console.error(`  Error batch ${batchNum}: ${error.message?.slice(0, 100)}`);

      // If too many consecutive errors, slow down
      if (consecutiveErrors >= 3) {
        currentDelay = Math.min(currentDelay * 2, 10000);
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

  const BATCH_SIZE = 50;

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(repos.length / BATCH_SIZE);
    process.stdout.write(`  [${batchNum}/${totalBatches}]\r`);

    // Build GraphQL query for this batch
    const repoQueries = batch.map((repo, idx) => {
      const [owner, name] = repo.split("/");
      return `repo${idx}: repository(owner: "${owner}", name: "${name}") {
        pushedAt
      }`;
    });

    const query = `query { ${repoQueries.join("\n")} }`;

    try {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
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

      // Extract results
      batch.forEach((repo, idx) => {
        const data = json.data?.[`repo${idx}`];
        if (data?.pushedAt) {
          results.set(repo, { pushedAt: data.pushedAt });
        } else {
          results.set(repo, null);
        }
      });
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
