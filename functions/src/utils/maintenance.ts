// Retention cleanup, triggered opportunistically from the request path.
// Cloudflare Pages does not support Cron Triggers (they are Workers-only), so
// instead of a scheduled alarm every isolate consults one CONFIG_KV timestamp:
// whoever sees it older than the interval claims the run by writing the
// current time *before* deleting, then hands the D1 work to ctx.waitUntil so
// the response path never waits for the deletes. The delete is idempotent, so
// two edges racing only costs a redundant pass.

import { createDatabase } from '../db';
import type { Env } from '../index';

const LAST_RUN_KEY = 'maintenance:last_usage_cleanup';
const MIN_INTERVAL_SECONDS = 24 * 60 * 60;
const DEFAULT_RETENTION_DAYS = 30;

/** Retention window in days; 0 disables cleanup, unset/unparseable falls back to 30. */
export function resolveRetentionDays(env: Env): number {
  const raw = env.USAGE_RETENTION_DAYS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RETENTION_DAYS;
  return parsed;
}

/**
 * Fire-and-forget gate. Never rejects: a KV hiccup must not turn into an
 * unhandled rejection on the request path. Returns immediately; the actual
 * deletes ride ctx.waitUntil.
 */
export function maybeRunScheduledCleanup(env: Env, ctx: ExecutionContext): void {
  const kv = env.CONFIG_KV;
  if (!kv || !env.DB) return;
  const days = resolveRetentionDays(env);
  // deleteUsageRecordsOlderThan(0) would mean "delete everything" — 0 is the
  // documented off switch, so the call is gated here rather than passed through.
  if (days <= 0) return;
  void (async () => {
    try {
      const last = await kv.get(LAST_RUN_KEY);
      const lastMs = last ? Number.parseInt(last, 10) : NaN;
      const now = Date.now();
      if (Number.isFinite(lastMs) && now - lastMs < MIN_INTERVAL_SECONDS * 1000) return;
      await kv.put(LAST_RUN_KEY, String(now), { expirationTtl: MIN_INTERVAL_SECONDS });
      ctx.waitUntil(
        createDatabase(env.DB)
          .deleteUsageRecordsOlderThan(days)
          .then(() => console.log(`usage cleanup: applied ${days}d retention`))
          .catch((error) => console.error('usage cleanup failed:', error instanceof Error ? error.message : String(error)))
      );
    } catch (error) {
      console.error('usage cleanup gate failed:', error instanceof Error ? error.message : String(error));
    }
  })();
}
