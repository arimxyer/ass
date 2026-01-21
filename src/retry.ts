// src/retry.ts

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter?: number;
}

/**
 * Sleep for a specified duration with optional jitter.
 *
 * @param ms - Base sleep duration in milliseconds
 * @param jitter - Jitter factor (0-1), adds random variation to prevent thundering herd. Default 0.2
 * @returns Promise that resolves after the sleep duration
 */
export function sleep(ms: number, jitter = 0.2): Promise<void> {
  const jitterMs = ms * jitter * (Math.random() - 0.5) * 2;
  return new Promise(resolve => setTimeout(resolve, ms + jitterMs));
}

/**
 * Calculate exponential backoff delay for a given attempt.
 *
 * @param attempt - Zero-based attempt number (0 = first retry)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @returns Delay in milliseconds, capped at maxDelayMs
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  return Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
}
