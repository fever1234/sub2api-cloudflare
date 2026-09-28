// Admin authentication throttling — a failure-only fixed window per client IP,
// backed by CONFIG_KV (the CF equivalent of Go's PanelRateLimiter). Counting
// only credential failures means a correct password can never be locked out by
// a previous wrong guess, and the short window lets a locked-out operator
// recover without intervention. KV outages fail open: an unreachable counter
// must never lock an operator out of their own deployment.

const WINDOW_SECONDS = 60;
const MAX_FAILURES = 5;
const KEY_PREFIX = 'rl:authfail:';

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip')?.trim() || 'local';
}

function throttleKey(ip: string): string {
  return `${KEY_PREFIX}${ip}`;
}

export async function checkLoginThrottle(kv: KVNamespace, ip: string): Promise<ThrottleDecision> {
  try {
    const value = await kv.get(throttleKey(ip));
    const count = value ? Number.parseInt(value, 10) : 0;
    if (Number.isFinite(count) && count >= MAX_FAILURES) {
      return { allowed: false, retryAfterSeconds: WINDOW_SECONDS };
    }
  } catch {
    // fail open
  }
  return { allowed: true, retryAfterSeconds: WINDOW_SECONDS };
}

export async function recordLoginFailure(kv: KVNamespace, ip: string): Promise<void> {
  try {
    const key = throttleKey(ip);
    const value = await kv.get(key);
    const count = ((value ? Number.parseInt(value, 10) : 0) || 0) + 1;
    // KV enforces a 60s minimum TTL, which is exactly the window length.
    await kv.put(key, String(count), { expirationTtl: WINDOW_SECONDS });
  } catch {
    // fail open
  }
}

export async function clearLoginThrottle(kv: KVNamespace, ip: string): Promise<void> {
  try {
    await kv.delete(throttleKey(ip));
  } catch {
    // fail open
  }
}
