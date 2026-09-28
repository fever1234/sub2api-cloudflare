// Failover logic with error rate and error count thresholds
import type { Env } from './index';
import type { Database } from './db';
import { Account, Group, AccountErrorStats, SelectAccountResult } from './types';
import { accountRateMultiplier } from './utils/proxy';
import { envInt, parseRetryAfterMs } from './utils/retry';

interface ErrorWindow {
  accountId: number;
  groupId: number;
  timestamps: number[];
  errors: number[];
}

/** Options that steer one request's account choice without changing policy. */
export interface SelectAccountOptions {
  /** Stable key (session id, prompt cache key) for sticky account routing. */
  stickyKey?: string;
}

/**
 * FNV-1a of `key:accountId`, used to pin a session to the same account as
 * long as it stays eligible. Deterministic across isolates, so the pin does
 * not change when the request lands on another isolate.
 */
function stickyHash(key: string, accountId: number): number {
  const seed = `${key}:${accountId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 4xx codes that describe the *account*, not the request.
 *
 * Each of these can succeed on a different credential, so they must move to the
 * next account rather than being handed back to the caller:
 *   401 key revoked or invalid
 *   402 balance exhausted / payment required
 *   403 plan or region not permitted
 *   404 this upstream does not serve the requested model
 *   408 upstream timed out
 *   409 transient conflict (some relays use this for a busy pool)
 *   425 sent too early
 *   429 rate limited or quota exceeded
 */
const ACCOUNT_LEVEL_FAILURES = new Set([401, 402, 403, 404, 408, 409, 425, 429]);

/**
 * How long a per-account error-stat row stays fresh.
 *
 * selectAccount reads one stats row per candidate account from D1, and the
 * retry loop calls it again — a request with N candidate accounts and 3 retries
 * could otherwise spend 4N subrequests on health alone, against a hard budget
 * of 50 per request. The routing snapshot already trades 5s of freshness for
 * its own D1 reads; health stats get the same window. An account that just
 * errored has its entry dropped (see recordRequest), so the failure that
 * should trip the circuit breaker is never served from cache.
 */
const ERROR_STATS_TTL_MS = 5_000;
let errorStatsHits = 0;
let errorStatsMisses = 0;

export function errorStatsCacheMetrics() {
  const samples = errorStatsHits + errorStatsMisses;
  return {
    hits: errorStatsHits,
    misses: errorStatsMisses,
    samples,
    hit_rate: samples ? Math.round(errorStatsHits / samples * 10000) / 100 : 0,
    ttl_ms: ERROR_STATS_TTL_MS
  };
}

export class FailoverManager {
  private errorWindows: Map<number, ErrorWindow> = new Map();
  private windowMs: number;
  private errorRateThreshold: number;
  private errorCountThreshold: number;
  private db?: Database;
  private lastUsed = new Map<number, number>();
  /** accountId → timestamp until which the account is rate-limited. */
  private cooldowns = new Map<number, number>();
  private defaultCooldownMs: number;
  private probeFailTtlMs: number;
  private stickyEnabled: boolean;
  /** accountId → still-fresh D1 health row (see ERROR_STATS_TTL_MS). */
  private statsCache = new Map<number, { expires: number; windowSeconds: number; stats: AccountErrorStats }>();

  constructor(env: Env) {
    const windowSeconds = Number(env.WINDOW_SECONDS);
    const errorRateThreshold = Number(env.ERROR_RATE_THRESHOLD);
    const errorCountThreshold = Number(env.ERROR_COUNT_THRESHOLD);
    this.windowMs = (Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 300) * 1000;
    this.errorRateThreshold = Number.isFinite(errorRateThreshold)
      ? Math.min(Math.max(errorRateThreshold, 0), 1)
      : 0.5;
    this.errorCountThreshold = Number.isFinite(errorCountThreshold) && errorCountThreshold > 0
      ? Math.floor(errorCountThreshold)
      : 5;
    this.defaultCooldownMs = envInt(env.RATE_LIMIT_COOLDOWN_MS, 30000);
    this.probeFailTtlMs = envInt(env.PROBE_FAIL_TTL_MS, 900000);
    this.stickyEnabled = (env.SESSION_STICKY ?? '1') !== '0';
  }

  setDb(db: Database) {
    this.db = db;
  }

  /**
   * Cool an account down after a rate-limit rejection. The upstream's own
   * Retry-After wins when present; otherwise the default window applies.
   * RATE_LIMIT_COOLDOWN_MS=0 disables cooldowns entirely.
   */
  noteRateLimit(accountId: number, status: number, retryAfter?: string | null): void {
    if (this.defaultCooldownMs <= 0) return;
    const parsed = parseRetryAfterMs(retryAfter);
    if (status !== 429 && parsed === null) return;
    const ttl = parsed ?? this.defaultCooldownMs;
    if (ttl <= 0) return;
    const until = Date.now() + ttl;
    if (until > (this.cooldowns.get(accountId) ?? 0)) {
      this.cooldowns.set(accountId, until);
    }
  }

  private inCooldown(accountId: number): boolean {
    const until = this.cooldowns.get(accountId);
    return until !== undefined && until > Date.now();
  }

  /** True when the account's most recent health probe failed within the TTL. */
  private probeFailed(acc: Account): boolean {
    if (acc.last_check_ok === null || acc.last_check_ok === undefined) return false;
    if (Number(acc.last_check_ok) !== 0) return false;
    const raw = String(acc.last_check_at || '');
    if (!raw) return false;
    // D1 datetime('now') writes 'YYYY-MM-DD HH:MM:SS' (UTC); ISO rows may
    // already carry T and an offset.
    const iso = /^\d{4}-\d{2}-\d{2}[ T]/.test(raw)
      ? raw.replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? '' : 'Z')
      : raw;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at <= this.probeFailTtlMs;
  }

  private alive(acc: Account): boolean {
    return !this.inCooldown(acc.id) && !this.probeFailed(acc);
  }

  private pruneCooldowns(): void {
    const now = Date.now();
    for (const [id, until] of this.cooldowns) {
      if (until <= now) this.cooldowns.delete(id);
    }
  }

  // Record request result for error tracking
  recordRequest(accountId: number, groupId: number, isError: boolean): void {
    const now = Date.now();
    const key = accountId;
    
    let window = this.errorWindows.get(key);
    if (!window) {
      window = {
        accountId,
        groupId,
        timestamps: [],
        errors: []
      };
      this.errorWindows.set(key, window);
    }
    
    // Clean old entries
    const cutoff = now - this.windowMs;
    while (window.timestamps.length > 0 && window.timestamps[0] < cutoff) {
      window.timestamps.shift();
      window.errors.shift();
    }
    
    // Add new entry
    window.timestamps.push(now);
    window.errors.push(isError ? 1 : 0);

    // A failure must be visible to the very next selection: drop the cached
    // health row so the circuit breaker re-reads it instead of believing a
    // pre-failure picture for the rest of the TTL.
    if (isError) this.statsCache.delete(accountId);
  }

  // Get error stats for an account
  private getMemoryErrorStats(accountId: number, group?: Group): AccountErrorStats {
    const window = this.errorWindows.get(accountId);
    if (!window) {
      return {
        accountId,
        groupId: 0,
        windowStart: Date.now() - this.windowMs,
        totalRequests: 0,
        errorCount: 0,
        errorRate: 0,
        isUnhealthy: false
      };
    }
    
    const totalRequests = window.timestamps.length;
    const errorCount = window.errors.reduce((sum, err) => sum + err, 0);
    const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0;
    
    const errorRateThreshold = group?.error_threshold ?? this.errorRateThreshold;
    const errorCountThreshold = group?.error_count_threshold ?? this.errorCountThreshold;
    return {
      accountId,
      groupId: window.groupId,
      windowStart: Date.now() - this.windowMs,
      totalRequests,
      errorCount,
      errorRate,
      isUnhealthy: errorRate > errorRateThreshold || errorCount >= errorCountThreshold
    };
  }

  async getErrorStats(accountId: number, group?: Group): Promise<AccountErrorStats> {
    const windowSeconds = Math.max(1, Number(group?.window_seconds) || this.windowMs / 1000);
    if (this.db) {
      const now = Date.now();
      const cached = this.statsCache.get(accountId);
      if (cached && cached.windowSeconds === windowSeconds && now < cached.expires) {
        errorStatsHits += 1;
        return { ...cached.stats, groupId: group?.id ?? 0 };
      }
      try {
        const persisted = await this.db.getAccountErrorStats(accountId, windowSeconds);
        const totalRequests = Number(persisted.total_requests || 0);
        const errorCount = Number(persisted.error_count || 0);
        const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0;
        const stats: AccountErrorStats = {
          accountId,
          groupId: group?.id ?? 0,
          windowStart: now - windowSeconds * 1000,
          totalRequests,
          errorCount,
          errorRate,
          isUnhealthy: errorRate > (group?.error_threshold ?? this.errorRateThreshold)
            || errorCount >= (group?.error_count_threshold ?? this.errorCountThreshold)
        };
        errorStatsMisses += 1;
        // Keep the cache bounded even if a burst of distinct accounts arrives.
        if (this.statsCache.size >= 512) {
          for (const [id, entry] of this.statsCache) {
            if (entry.expires <= now) this.statsCache.delete(id);
          }
          if (this.statsCache.size >= 512) this.statsCache.clear();
        }
        this.statsCache.set(accountId, { expires: now + ERROR_STATS_TTL_MS, windowSeconds, stats });
        return stats;
      } catch {
        // Fall back to the isolate-local window when D1 is temporarily unavailable.
      }
    }
    return this.getMemoryErrorStats(accountId, group);
  }

  // Select best account from available accounts
  async selectAccount(
    accounts: Account[],
    groups: Map<number, Group>,
    preferredGroupId?: number,
    fallbackGroupIds: number[] = [],
    opts: SelectAccountOptions = {}
  ): Promise<SelectAccountResult | null> {
    if (accounts.length === 0) return null;
    this.pruneCooldowns();

    const usableAccounts = accounts.filter(acc => {
      const group = groups.get(acc.group_id);
      return acc.enabled === 1 && Boolean(group && group.enabled === 1);
    });
    if (usableAccounts.length === 0) return null;

    // A pinned primary group is a hard first tier. A fallback group is only
    // considered after the primary tier has no candidate left; this prevents a
    // slower/cheaper account in another group from stealing primary traffic.
    const primary = preferredGroupId
      ? usableAccounts.filter(acc => acc.group_id === preferredGroupId)
      : [];
    const hasFallbackPolicy = Boolean(preferredGroupId && fallbackGroupIds.length);
    const initialAccounts = primary.length > 0
      ? primary
      : hasFallbackPolicy
        ? usableAccounts.filter(acc => fallbackGroupIds.includes(acc.group_id))
        : usableAccounts;
    if (initialAccounts.length === 0) return null;

    // Rate-limit cooldowns and failed probes steer traffic away from sick
    // accounts. Steering is soft: when nothing in the tier is alive the tier
    // is restored, so a cooldown can rotate load but never refuse service.
    let candidates = initialAccounts.filter(acc => this.alive(acc));
    if (candidates.length === 0 && hasFallbackPolicy && primary.length > 0) {
      // The pinned tier has no living account; hand the request to the
      // fallback tier instead of restoring dead accounts immediately.
      const fallbackAlive = usableAccounts.filter(
        acc => fallbackGroupIds.includes(acc.group_id) && this.alive(acc)
      );
      if (fallbackAlive.length > 0) candidates = fallbackAlive;
    }
    if (candidates.length === 0) candidates = initialAccounts;

    const statsByAccount = new Map<number, AccountErrorStats>(
      await Promise.all(candidates.map(async acc => [
        acc.id,
        await this.getErrorStats(acc.id, groups.get(acc.group_id))
      ] as const))
    );
    let healthyAccounts = candidates.filter(acc => !statsByAccount.get(acc.id)!.isUnhealthy);

    // With a primary/fallback policy, an unhealthy primary tier must not be
    // selected merely because it is the least unhealthy. Move to the fallback
    // tier instead. If the fallback tier is also unhealthy, use its least-bad
    // account as the final admission fallback rather than failing outright.
    if (healthyAccounts.length === 0 && hasFallbackPolicy && primary.length > 0) {
      const fallback = usableAccounts.filter(acc => fallbackGroupIds.includes(acc.group_id));
      if (fallback.length === 0) return null;
      const fallbackStats = await Promise.all(fallback.map(async acc => [
        acc.id,
        await this.getErrorStats(acc.id, groups.get(acc.group_id))
      ] as const));
      for (const [id, stats] of fallbackStats) statsByAccount.set(id, stats);
      healthyAccounts = fallback.filter(acc => !statsByAccount.get(acc.id)!.isUnhealthy);
      if (healthyAccounts.length === 0) healthyAccounts = fallback;
    }

    // Every account is circuit-broken: fall back to the least unhealthy rather
    // than refusing the request outright. This applies only when there is no
    // explicit fallback tier, or after the fallback tier has been selected.
    if (healthyAccounts.length === 0) {
      healthyAccounts = [...candidates].sort((a, b) => {
        const statsA = statsByAccount.get(a.id)!;
        const statsB = statsByAccount.get(b.id)!;
        return statsA.errorRate - statsB.errorRate || statsA.errorCount - statsB.errorCount;
      });
    }

    const stickyKey = this.stickyEnabled && opts.stickyKey ? opts.stickyKey : undefined;
    healthyAccounts.sort((a, b) => {
      const groupA = groups.get(a.group_id)!;
      const groupB = groups.get(b.group_id)!;
      const statsA = statsByAccount.get(a.id)!;
      const statsB = statsByAccount.get(b.id)!;
      // Explicit ordering stays dominant so operators keep hard control: group
      // priority first, then account priority. Billing weight only breaks ties
      // between equally-prioritised accounts, where preferring the cheaper
      // upstream costs nothing. Sticky routing then replaces pure LRU so a
      // session keeps landing on the same account — prompt-cache reuse and
      // conversation state both benefit — while still yielding to accounts
      // with better health.
      return (groupA.priority - groupB.priority)
        || (a.priority - b.priority)
        || (accountRateMultiplier(a) - accountRateMultiplier(b))
        || (statsA.errorRate - statsB.errorRate)
        || (statsA.errorCount - statsB.errorCount)
        || (stickyKey
          ? stickyHash(stickyKey, a.id) - stickyHash(stickyKey, b.id)
          : (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0))
        || (a.id - b.id);
    });

    const selected = healthyAccounts[0];
    const group = groups.get(selected.group_id);
    if (!group) return null;
    this.lastUsed.set(selected.id, Date.now());

    return {
      account: selected,
      group,
      stats: statsByAccount.get(selected.id) ?? null
    };
  }

  /** Persist a health probe result so the console can show liveness. */
  async recordHealthCheck(accountId: number, ok: boolean, latencyMs: number, message: string): Promise<void> {
    if (!this.db) return;
    await this.db.recordAccountHealthCheck(accountId, ok, latencyMs, message).catch(() => {});
  }

  // Check if error should trigger failover
  shouldFailover(error: any): boolean {
    if (!error) return false;

    const status = error.status || error.statusCode || 0;

    // A status is retried when a *different account* could plausibly succeed.
    //
    // The earlier rule only retried 408/425/429/5xx, which left the most common
    // real-world account failures unhandled: an expired key (401), an unpaid
    // account (402) and a plan without access (403) were all returned straight
    // to the client while the dead account stayed in rotation. Those are
    // properties of the credential, not of the request, so another account is
    // exactly what should serve it.
    if (status === 0 || status >= 500) return true;
    if (ACCOUNT_LEVEL_FAILURES.has(status)) return true;

    // Everything else in 4xx describes the request itself — a malformed body,
    // an oversized payload, a rejected parameter. Replaying it against another
    // account produces the identical error while burning that account's quota
    // and the caller's latency budget, so it is surfaced immediately.
    return false;
  }

  // Cleanup old windows periodically
  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs * 2; // Keep 2x window for safety
    
    for (const [key, window] of this.errorWindows) {
      if (window.timestamps.length > 0 && window.timestamps[window.timestamps.length - 1] < cutoff) {
        this.errorWindows.delete(key);
      }
    }
  }
}

