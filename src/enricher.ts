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

  // Batch query using GraphQL (100 at a time, with rate limiting)
  const batchSize = 100;
  const delayMs = 1000; // 1 second between batches to avoid secondary rate limit

  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);

    // Add delay between batches (except first)
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    console.log(`  Enriching batch ${i / batchSize + 1}/${Math.ceil(repos.length / batchSize)}...`);

    const query = `
      query {
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
    } catch (error: any) {
      console.error(`Error enriching batch ${i}-${i + batchSize}:`, error.message);
    }
  }

  return items;
}
