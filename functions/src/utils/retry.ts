// Retry pacing helpers shared by the gateway routes: backoff, a wall-clock
// budget across attempts, Retry-After parsing and a client-aware sleep.
import type { Env } from '../index';

/** Parse a non-negative integer env var, falling back when absent or invalid. */
export function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Exponential backoff with half-jitter before starting attempt `attempt`
 * (1-based). Delays stay within RETRY_BASE_DELAY_MS..RETRY_MAX_DELAY_MS so a
 * sick upstream gets breathing room without making the caller wait long.
 */
export function retryDelayMs(attempt: number, env: Env): number {
  const base = envInt(env.RETRY_BASE_DELAY_MS, 300);
  const max = envInt(env.RETRY_MAX_DELAY_MS, 3000);
  if (base <= 0) return 0;
  const delay = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), max);
  return Math.floor(delay / 2 + Math.random() * (delay / 2));
}

/** Total wall-clock time all retries of one request may consume. */
export function retryBudgetMs(env: Env): number {
  return envInt(env.RETRY_BUDGET_MS, 120000);
}

/** True once the request has spent its retry budget on upstream attempts. */
export function retryBudgetExceeded(originStartedAt: number, env: Env): boolean {
  return Date.now() - originStartedAt >= retryBudgetMs(env);
}

/** Sleep that resolves early when the client disconnects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Parse a Retry-After header (seconds or HTTP-date) into milliseconds.
 * Returns null when absent or unparseable so callers can apply a default.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = String(header).trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}
