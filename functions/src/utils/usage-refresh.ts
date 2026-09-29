// OpenCode Go subscription usage windows (Go: service/opencode_go_usage.go).
//
// The official endpoint reports rolling/weekly/monthly quota windows for a
// subscription key. Go refreshes them from a background runner driven by
// request activity (debounce + max-wait, leader-locked across instances); a
// Worker has no loop, so the refresh is scheduled from the request path: a due
// account fetches once per interval inside waitUntil, and the routing-snapshot
// row is mutated in place so a warm isolate does not refetch within its TTL.
// The debounce input (group last_used_at) is not persisted here, so activity
// only *triggers* the check — the interval is the sole rate bound.
import type { Env } from '../index';
import type { Deferrable } from './background';
import { createDatabase } from '../db';

export const OPENCODE_USAGE_DEFAULT_URL = 'https://opencode.ai/zen/go/v1/usage';

/** Max-wait bound between automatic refreshes (Go: default interval 15 minutes). */
export const OPENCODE_USAGE_INTERVAL_MS = 15 * 60 * 1000;

/** Manual refreshes share Go's one-per-30-seconds limit. */
export const OPENCODE_USAGE_MANUAL_MIN_GAP_MS = 30 * 1000;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export interface UsageWindow {
  status: string;
  percent: number;
  resets_at: string | null;
}

export interface UsageData {
  rolling: UsageWindow;
  weekly: UsageWindow;
  monthly: UsageWindow;
}

export interface UsageSnapshot {
  status: 'ok' | 'unauthorized' | 'failed';
  data?: UsageData;
  fetched_at?: string;
  last_attempt_at: string;
  next_refresh_at: string;
  failure_count?: number;
  http_status?: number;
  last_error?: string;
}

export function readUsageSnapshot(account: { usage_snapshot?: unknown } | null | undefined): UsageSnapshot | null {
  const raw = account?.usage_snapshot;
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || !parsed.last_attempt_at) return null;
    return parsed as UsageSnapshot;
  } catch {
    return null;
  }
}

/**
 * The official base-url match (Go: isOpenCodeGoBaseURL): https, host exactly
 * opencode.ai (port 443 tolerated), path exactly /zen/go or /zen/go/v1, and no
 * query/fragment/userinfo. Everything else — proxies, relays, other hosts —
 * must not claim the subscription identity.
 */
export function isOpenCodeGoBaseUrl(raw: unknown): boolean {
  const value = String(raw || '').trim();
  if (!value || /[?#]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
  if (url.hostname.toLowerCase() !== 'opencode.ai') return false;
  // Non-default ports are rejected: URL normalises :443 away, so any host that
  // still carries a port here is not the official authority.
  if (url.host.toLowerCase() !== 'opencode.ai') return false;
  const path = url.pathname.replace(/\/$/, '').toLowerCase();
  return path === '/zen/go/v1' || path === '/zen/go';
}

/**
 * Whether this account's api key carries OpenCode Go quota windows (Go:
 * IsOpenCodeGoUsageAccount). `opencode_go` accounts qualify by platform — this
 * port does not track plan mode, so a pay-as-you-go key simply lands in the
 * `unauthorized`/`failed` snapshot instead of being filtered out. Other
 * platforms qualify only when their base_url points at the official host;
 * xai is not a Go mount platform and stays excluded.
 */
export function isOpenCodeGoUsageAccount(account: { provider?: string; api_key?: string; base_url?: string } | null | undefined): boolean {
  if (!account || !String(account.api_key || '').trim()) return false;
  if (account.provider === 'opencode_go') return true;
  if (account.provider !== 'openai' && account.provider !== 'anthropic') return false;
  return isOpenCodeGoBaseUrl(account.base_url);
}

/**
 * Success: due once `interval` has passed since the last fetch. Failure: due
 * once the stored backoff (`next_refresh_at`) has elapsed. A missing or
 * unreadable snapshot fails open to a first fetch.
 */
export function isUsageRefreshDue(
  snapshot: UsageSnapshot | null,
  now: number,
  intervalMs = OPENCODE_USAGE_INTERVAL_MS
): boolean {
  if (!snapshot) return true;
  if (snapshot.status === 'ok') {
    const fetched = Date.parse(snapshot.fetched_at || '');
    if (!Number.isFinite(fetched)) return true;
    return now >= fetched + intervalMs;
  }
  const next = Date.parse(snapshot.next_refresh_at || '');
  if (!Number.isFinite(next)) return true;
  return now >= next;
}

export function isManualRefreshRateLimited(snapshot: UsageSnapshot | null, now: number): boolean {
  const last = Date.parse(snapshot?.last_attempt_at || '');
  return Number.isFinite(last) && now - last < OPENCODE_USAGE_MANUAL_MIN_GAP_MS;
}

function emptyWindow(): UsageWindow {
  return { status: '', percent: 0, resets_at: null };
}

function windowFrom(raw: unknown): UsageWindow {
  if (!raw || typeof raw !== 'object') return emptyWindow();
  const source = raw as Record<string, unknown>;
  const percent = Number(source.percent);
  const resetRaw = String(source.resetsAt ?? source.resets_at ?? '');
  const reset = Date.parse(resetRaw);
  return {
    status: String(source.status ?? ''),
    percent: Number.isFinite(percent) ? percent : 0,
    resets_at: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
  };
}

/**
 * Lenient parse of the official payload (Go: parseOpenCodeGoUsageJSON): the
 * windows may sit under a top-level `usage` wrapper or directly on the root,
 * missing windows degrade to zero values, and only structurally invalid JSON
 * is an error.
 */
export function parseOpenCodeGoUsageJson(text: string): UsageData | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const envelope = root as Record<string, unknown>;
  const usage = (envelope.usage && typeof envelope.usage === 'object' ? envelope.usage : root) as Record<string, unknown>;
  return {
    rolling: windowFrom(usage.rolling),
    weekly: windowFrom(usage.weekly),
    monthly: windowFrom(usage.monthly),
  };
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

/** Exponential retry from the stored failure count, capped at 24h (Go: backoff). */
function failureDelayMs(failureCount: number, intervalMs: number): number {
  const exponent = Math.min(Math.max(failureCount - 1, 0), 6);
  return Math.min(intervalMs * 2 ** exponent, MAX_BACKOFF_MS);
}

function buildFailure(
  previous: UsageSnapshot | null,
  now: number,
  reason: string,
  httpStatus: number,
  status: 'failed' | 'unauthorized',
  intervalMs: number
): UsageSnapshot {
  const failureCount = (previous?.failure_count || 0) + 1;
  const snapshot: UsageSnapshot = {
    status,
    last_attempt_at: iso(now),
    next_refresh_at: iso(now + failureDelayMs(failureCount, intervalMs)),
    failure_count: failureCount,
    last_error: reason,
  };
  if (httpStatus) snapshot.http_status = httpStatus;
  // A failed refresh must not erase the last known windows.
  if (previous?.data) snapshot.data = previous.data;
  if (previous?.fetched_at) snapshot.fetched_at = previous.fetched_at;
  return snapshot;
}

/**
 * Fetch the official usage JSON for one account and persist the snapshot.
 * The stored account row (and the warm routing object it was read into) is
 * updated together so the next due check in this isolate sees the new state.
 */
export async function refreshAccountUsage(
  account: { id: number; api_key?: string },
  env: Env,
  intervalMs = OPENCODE_USAGE_INTERVAL_MS
): Promise<UsageSnapshot> {
  const now = Date.now();
  const url = String(env.OPENCODE_USAGE_URL || '').trim() || OPENCODE_USAGE_DEFAULT_URL;
  const previous = readUsageSnapshot(account as any);
  let snapshot: UsageSnapshot;

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${String(account.api_key || '')}`,
        'user-agent': 'sub2api-opencode-go-usage/1',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const status = response.status;
    if (status >= 300 && status < 400) {
      snapshot = buildFailure(previous, now, 'redirect_blocked', status, 'failed', intervalMs);
    } else if (status === 401) {
      snapshot = buildFailure(previous, now, 'unauthorized', status, 'unauthorized', intervalMs);
    } else if (status === 403) {
      snapshot = buildFailure(previous, now, 'subscription_required (403)', status, 'failed', intervalMs);
    } else if (status < 200 || status >= 300) {
      snapshot = buildFailure(previous, now, 'http_error', status, 'failed', intervalMs);
    } else {
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) {
        snapshot = buildFailure(previous, now, 'response_too_large', status, 'failed', intervalMs);
      } else {
        const data = parseOpenCodeGoUsageJson(text);
        snapshot = data
          ? {
              status: 'ok',
              data,
              fetched_at: iso(now),
              last_attempt_at: iso(now),
              next_refresh_at: iso(now + intervalMs),
              http_status: status,
            }
          : buildFailure(previous, now, 'invalid_json', status, 'failed', intervalMs);
      }
    }
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'request_timeout' : 'request_failed';
    snapshot = buildFailure(previous, now, reason, 0, 'failed', intervalMs);
  }

  const raw = JSON.stringify(snapshot);
  const db = createDatabase(env.DB);
  await db.updateAccount(account.id, { usage_snapshot: raw }).catch(() => {});
  (account as { usage_snapshot?: string }).usage_snapshot = raw;
  return snapshot;
}

const inflight = new Map<number, Promise<unknown>>();

/**
 * Fire the refresh for a due, eligible account without blocking the request.
 * The in-flight guard keeps one isolate from stacking fetches while the
 * response is still streaming; separate isolates may still race, which costs
 * at most one extra GET per interval.
 */
export function scheduleUsageRefresh(account: any, env: Env, ctx?: Deferrable): void {
  try {
    if (!isOpenCodeGoUsageAccount(account)) return;
    if (inflight.has(account.id)) return;
    if (!isUsageRefreshDue(readUsageSnapshot(account), Date.now())) return;
    const task = refreshAccountUsage(account, env)
      .catch(() => undefined)
      .finally(() => { inflight.delete(account.id); });
    inflight.set(account.id, task);
    ctx?.waitUntil?.(task);
  } catch {
    // Telemetry must never surface as a failure to the caller.
  }
}

/** The admin DTO: eligibility plus the stored snapshot (Go: OpenCodeGoUsageState). */
export function usageStateFromAccount(account: any): { account_id: number; eligible: boolean; snapshot: UsageSnapshot | null } {
  return {
    account_id: Number(account?.id) || 0,
    eligible: isOpenCodeGoUsageAccount(account),
    snapshot: readUsageSnapshot(account),
  };
}
