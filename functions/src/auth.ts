// Authentication utilities designed for the Workers Web Crypto runtime.
import type { Database } from './db';

export interface Session {
  userId: number;
  username: string;
  isAdmin: boolean;
  expiresAt: number;
}

const PASSWORD_ITERATIONS = 100_000;

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function derivePassword(password: string, salt: Uint8Array, iterations = PASSWORD_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${toHex(salt)}$${hash}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // Current format: pbkdf2$iterations$salt$hash.
  const parts = storedHash.split('$');
  if (parts.length === 4 && parts[0] === 'pbkdf2') {
    const iterations = Number(parts[1]);
    if (!Number.isSafeInteger(iterations) || iterations < 10_000 || parts[2].length !== 32) return false;
    const actual = await derivePassword(password, fromHex(parts[2]), iterations);
    return actual === parts[3];
  }

  // Compatibility with the original SHA-256-only records.
  if (/^[0-9a-f]{64}$/i.test(storedHash)) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    return toHex(digest).toLowerCase() === storedHash.toLowerCase();
  }
  return false;
}

export async function authenticateUser(db: Database, username: string, password: string): Promise<Session | null> {
  const user = await db.getUserByUsername(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) return null;
  return {
    userId: user.id,
    username: user.username,
    isAdmin: true,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
}

async function signJwt(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64UrlEncode(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

export async function createSessionToken(session: Session, secret: string): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    sub: session.userId,
    username: session.username,
    admin: session.isAdmin,
    exp: Math.floor(session.expiresAt / 1000)
  }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${await signJwt(signingInput, secret)}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<Session | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    if (!payload.exp || Math.floor(Date.now() / 1000) >= payload.exp) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid || typeof payload.sub !== 'number' || typeof payload.username !== 'string') return null;
    return { userId: payload.sub, username: payload.username, isAdmin: payload.admin === true, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
}

/**
 * Resolve the token signing secret.
 *
 * A hardcoded fallback would be published in this repository, letting anyone
 * forge an admin token against a deployment that forgot to set JWT_SECRET. So
 * prefer the configured secret and otherwise persist a generated random one in
 * D1, which keeps sessions valid across isolates and redeploys.
 */
export async function resolveSessionSecret(db: Database, configured?: string): Promise<string> {
  const explicit = String(configured || '').trim();
  if (explicit) return explicit;

  const stored = await db.getSetting('session_secret');
  if (stored) return stored;

  const generated = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return db.setSettingIfAbsent('session_secret', generated);
}

export async function hashApiKey(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  return toHex(digest);
}

/**
 * Isolate-local cache for API-key authentication.
 *
 * Every gateway request pays a D1 SELECT just to prove its key exists, and a
 * Workers request has a hard subrequest budget — on top of which the routing
 * snapshot and per-account health already spend queries. A key row changes
 * only when an admin edits it (every such write clears this cache from the
 * keys handler) or when its balance crosses the quota gate, so a short TTL
 * bounds the staleness to a few seconds of possible quota overshoot, while a
 * warm isolate authenticates for free.
 *
 * Negative results are cached too: without them, replaying one bad key is a
 * D1 query per request.
 */
const API_KEY_CACHE_TTL_MS = 5_000;
const apiKeyCache = new Map<string, { expires: number; key: any | null }>();
let apiKeyHits = 0;
let apiKeyMisses = 0;

/** Drop every cached key decision (admin edits a key: create/update/delete). */
export function invalidateApiKeyCache(): void {
  apiKeyCache.clear();
}

export function apiKeyCacheMetrics() {
  const samples = apiKeyHits + apiKeyMisses;
  return {
    hits: apiKeyHits,
    misses: apiKeyMisses,
    samples,
    hit_rate: samples ? Math.round(apiKeyHits / samples * 10000) / 100 : 0,
    ttl_ms: API_KEY_CACHE_TTL_MS
  };
}

export async function authenticateApiKey(db: Database, apiKey: string): Promise<any | null> {
  const keyHash = await hashApiKey(apiKey);
  const now = Date.now();
  const cached = apiKeyCache.get(keyHash);
  if (cached && now < cached.expires) {
    apiKeyHits += 1;
    return cached.key;
  }
  apiKeyMisses += 1;

  const key = await db.getApiKeyByHash(keyHash);
  const valid = key && key.enabled && !(key.quota_limit > 0 && key.balance >= key.quota_limit)
    ? key
    : null;

  // Bound the map so a key-spray cannot grow isolate memory without limit.
  if (apiKeyCache.size >= 1024) {
    for (const [hash, entry] of apiKeyCache) {
      if (entry.expires <= now) apiKeyCache.delete(hash);
    }
    if (apiKeyCache.size >= 1024) apiKeyCache.clear();
  }
  apiKeyCache.set(keyHash, { expires: now + API_KEY_CACHE_TTL_MS, key: valid });
  return valid;
}
