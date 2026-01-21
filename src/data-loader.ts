// src/data-loader.ts
import { CONFIG } from "./config";
import type { z } from "zod";

interface LoadOptions<T> {
  /** Filename to load (relative to data directory) */
  filename: string;
  /** Optional Zod schema for runtime validation */
  schema?: z.ZodType<T>;
  /** Whether the file is gzipped */
  gzipped?: boolean;
}

/**
 * Load data from CDN with fallback to local files.
 *
 * Tries sources in order:
 * 1. jsDelivr CDN (fastest, global)
 * 2. GitHub raw content (fallback)
 * 3. Local data directory (development)
 *
 * Features:
 * - Network timeout protection
 * - Error aggregation from all sources
 * - Optional Zod schema validation
 * - Supports both JSON and gzipped JSON
 *
 * @throws AggregateError if all sources fail
 */
export async function loadData<T>(options: LoadOptions<T>): Promise<T> {
  const { filename, schema, gzipped = false } = options;
  const errors: Error[] = [];
  const sources = [
    { name: "jsDelivr", url: CONFIG.network.cdnUrls.jsdelivr },
    { name: "GitHub", url: CONFIG.network.cdnUrls.githubRaw },
  ];

  for (const source of sources) {
    try {
      const res = await fetch(`${source.url}/${filename}`, {
        signal: AbortSignal.timeout(CONFIG.network.timeout),
      });

      if (res.ok) {
        let data: unknown;

        if (gzipped) {
          const compressed = new Uint8Array(await res.arrayBuffer());
          const decompressed = Bun.gunzipSync(compressed);
          data = JSON.parse(new TextDecoder().decode(decompressed));
        } else {
          data = await res.json();
        }

        // Validate with schema if provided
        if (schema) {
          return schema.parse(data);
        }
        return data as T;
      }

      // Non-OK response
      errors.push(new Error(`${source.name}: HTTP ${res.status}`));
    } catch (e) {
      const error = e as Error;
      const isTimeout = error.name === "TimeoutError" || error.name === "AbortError";
      const message = isTimeout
        ? `${source.name}: timeout after ${CONFIG.network.timeout}ms`
        : `${source.name}: ${error.message}`;
      console.warn(`Failed to load ${filename} from ${source.name}: ${message}`);
      errors.push(new Error(message));
    }
  }

  // Local fallback
  try {
    const localPath = new URL(`../data/${filename}`, import.meta.url);
    let data: unknown;

    if (gzipped) {
      const compressed = await Bun.file(localPath).arrayBuffer();
      const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
      data = JSON.parse(new TextDecoder().decode(decompressed));
    } else {
      data = await Bun.file(localPath).json();
    }

    // Validate with schema if provided
    if (schema) {
      return schema.parse(data);
    }
    return data as T;
  } catch (e) {
    const error = e as Error;
    console.warn(`Failed to load ${filename} from local: ${error.message}`);
    errors.push(new Error(`local: ${error.message}`));
  }

  throw new AggregateError(
    errors,
    `Failed to load ${filename} from all sources (jsDelivr, GitHub, local)`
  );
}

/**
 * Convenience function to load gzipped data.
 * Equivalent to loadData({ filename, gzipped: true, schema }).
 */
export async function loadGzippedData<T>(
  filename: string,
  schema?: z.ZodType<T>
): Promise<T> {
  return loadData({ filename, gzipped: true, schema });
}
