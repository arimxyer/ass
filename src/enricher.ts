// src/enricher.ts
import { Octokit } from "octokit";
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

  const octokit = new Octokit({ auth: token });

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
      const result: any = await octokit.graphql(query);

      // Log rate limit status periodically
      const rl = result.rateLimit;
      if (batchNum % 10 === 0 || rl.remaining < 100) {
        console.log(`  [${batchNum}/${totalBatches}] Rate limit: ${rl.remaining} remaining, cost: ${rl.cost}`);
      } else {
        process.stdout.write(`  [${batchNum}/${totalBatches}]\r`);
      }

      // If running low on points, slow down
      if (rl.remaining < 500) {
        currentDelay = Math.min(currentDelay * 1.5, 5000);
        console.log(`  ⚠️ Low rate limit (${rl.remaining}), increasing delay to ${currentDelay}ms`);
      }

      // Process results
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
      if (error.message?.includes("SecondaryRateLimit")) {
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
