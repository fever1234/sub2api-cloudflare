// OpenCode Go upstream identity headers.
//
// Ported from Wei-Shaw/sub2api service/openai_opencode_session.go, keeping
// the three behaviours the upstream actually enforces:
//
//  1. x-opencode-session is mandatory on Go inference calls (MissingSessionID
//     since 2026-09-05). It must be stable per conversation or upstream prompt
//     caching is defeated, so it is resolved from the client's own signals
//     before a random value is ever generated.
//  2. The outbound User-Agent must look like a real coding agent. opencode.ai
//     sits behind a Cloudflare WAF that rejects generic SDK/HTTP-library UAs
//     with error 1010, and that 403 then reads as a dead credential.
//  3. When the client sends no session signal at all (most third-party
//     OpenAI-compatible harnesses send neither a session header nor
//     prompt_cache_key), a per-request random UUID would make every turn look
//     like a new conversation and upstream prompt cache can never hit. sub2api
//     solves this with a content-derived seed (model + tools + leading system
//     prefix + first user message); this port does the same so the session
//     stays identical across the turns of one conversation.

const SESSION_HEADER = 'x-opencode-session';

/**
 * Explicit conversation-id headers, in sub2api's priority order
 * (explicitOpenAIHeaderSessionNames + ClaudeCodeSessionIDFromHeader).
 * Request/message ids are deliberately absent: they rotate every turn.
 */
const SESSION_HEADERS = [
  'x-opencode-session',
  'session-id',
  'session_id',
  'conversation_id',
  'x-session-affinity',
  'x-session-id',
  'x-conversation-id',
  'x-claude-code-session-id',
];

/** Canonical outbound UA for OpenCode upstreams (the real opencode client format). */
const OPENCODE_UPSTREAM_USER_AGENT = 'opencode/1.0.0';

const SESSION_ID_MAX_LENGTH = 256;

export interface OpenCodeHeaderInput {
  /** Headers the client sent to this gateway. */
  clientHeaders?: Headers | Record<string, string> | null;
  /** Parsed JSON request body; session hints live in its documented fields. */
  body?: unknown;
  /** Outbound headers built so far; an already-applied value wins over minting. */
  appliedHeaders?: Record<string, string> | null;
  /**
   * Whether a UUID may be minted when nothing stable was found. Always true
   * for opencode_go accounts: a missing header is a hard upstream error, and
   * a fresh UUID costs only the cache miss a missing header would cost anyway.
   */
  allowGenerate?: boolean;
}

function headerGet(headers: Headers | Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  if (typeof (headers as Headers).get === 'function') {
    return String((headers as Headers).get(name) || '').trim();
  }
  const record = headers as Record<string, string>;
  const lower = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower) return String(record[key] ?? '').trim();
  }
  return '';
}

/** Trim and drop control characters so a hostile header cannot inject framing. */
function sanitizeSessionId(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '');
  return cleaned.slice(0, SESSION_ID_MAX_LENGTH);
}

/**
 * Read the stable conversation id from the documented body fields.
 *
 * OpenAI-protocol clients send prompt_cache_key (Chat Completions and
 * Responses); Anthropic-protocol clients send metadata.user_id, which is
 * either the id itself or a JSON string carrying session_id. Neither field
 * changes model behaviour, so they are safe to reuse as the session value.
 */
function sessionIdFromBody(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, any>;

  const fromCacheKey = sanitizeSessionId(record.prompt_cache_key);
  if (fromCacheKey) return fromCacheKey;

  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') {
    const userId = sanitizeSessionId((metadata as Record<string, any>).user_id);
    if (userId) {
      if (userId.startsWith('{')) {
        try {
          const parsed = JSON.parse(userId);
          const nested = sanitizeSessionId(parsed?.session_id);
          if (nested) return nested;
        } catch {
          // Not JSON after all; the raw value is the session id.
        }
      }
      return userId;
    }
  }
  return '';
}

/** Canonical prefix so content-derived seeds can never collide with an
 * explicit session id (mirrors sub2api's compat_cs_ convention). */
const CONTENT_SEED_PREFIX = 'compat_cs_';

/** Bound the hash input so a pathological body cannot burn CPU. */
const CONTENT_SEED_MAX_CHARS = 100_000;

function jsonOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Two decorrelated 32-bit FNV-style streams → 16 hex chars. */
function seedHash(material: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < material.length; i++) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Content-derived conversation seed (port of sub2api's
 * deriveOpenAIContentSessionSeed): only fields constant across turns are
 * hashed — model, tools/functions definitions, instructions, the leading
 * system/developer prefix, and the first user message. The same conversation
 * therefore yields the same seed on every turn, while a different opening
 * message or model yields a different one. Whitespace differences in the
 * client's JSON do not matter because values are re-serialized, not compared
 * as raw bytes.
 */
export function deriveContentSessionSeed(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const rec = body as Record<string, any>;

  const parts: string[] = [];
  const model = typeof rec.model === 'string' ? rec.model.trim() : '';
  if (model) parts.push('model=' + model);
  if (Array.isArray(rec.tools) && rec.tools.length > 0) parts.push('|tools=' + jsonOf(rec.tools));
  if (Array.isArray(rec.functions) && rec.functions.length > 0) parts.push('|functions=' + jsonOf(rec.functions));
  if (typeof rec.instructions === 'string' && rec.instructions !== '') {
    parts.push('|instructions=' + rec.instructions);
  }

  let firstUserCaptured = false;
  const captureFirstUser = (content: unknown) => {
    if (firstUserCaptured) return;
    parts.push('|first_user=' + jsonOf(content));
    firstUserCaptured = true;
  };

  if (Array.isArray(rec.messages)) {
    // Chat Completions: only the LEADING system/developer prefix counts;
    // a later system message must not change the seed mid-conversation.
    let systemPrefixOpen = true;
    for (const message of rec.messages) {
      if (!message || typeof message !== 'object') {
        systemPrefixOpen = false;
        continue;
      }
      const role = message.role;
      if ((role === 'system' || role === 'developer') && systemPrefixOpen) {
        parts.push('|system=' + jsonOf(message.content));
      } else if (role === 'user') {
        systemPrefixOpen = false;
        captureFirstUser(message.content);
      } else {
        systemPrefixOpen = false;
      }
    }
  } else if (Array.isArray(rec.input)) {
    // Responses API input items.
    for (const item of rec.input) {
      if (!item || typeof item !== 'object') continue;
      if (item.role === 'system' || item.role === 'developer') {
        parts.push('|system=' + jsonOf(item.content));
      } else if (item.role === 'user') {
        captureFirstUser(item.content);
      }
      if (!firstUserCaptured && item.type === 'input_text') {
        parts.push('|first_user=' + (typeof item.text === 'string' ? item.text : ''));
        firstUserCaptured = true;
      }
    }
  } else if (typeof rec.input === 'string' && rec.input !== '') {
    parts.push('|input=' + rec.input);
  }

  if (parts.length === 0) return '';
  const material = parts.join('').slice(0, CONTENT_SEED_MAX_CHARS);
  return CONTENT_SEED_PREFIX + seedHash(material);
}

/**
 * Resolve the x-opencode-session value for one outbound call.
 *
 * Order mirrors sub2api: explicit client headers (session-id / session_id /
 * conversation_id / x-session-affinity / x-session-id / x-opencode-session /
 * x-conversation-id / x-claude-code-session-id), then the documented body
 * fields, then anything already applied (operator spoofing). The content
 * seed replaces sub2api's last-resort UUID for stateless bodies so a client
 * with no session signal still keeps one stable id across conversation turns;
 * a UUID remains only for signal-less, body-less probes.
 */
export function resolveOpenCodeSessionId(input: OpenCodeHeaderInput): string {
  for (const name of SESSION_HEADERS) {
    const fromHeader = sanitizeSessionId(headerGet(input.clientHeaders, name));
    if (fromHeader) return fromHeader;
  }

  const fromBody = sessionIdFromBody(input.body);
  if (fromBody) return fromBody;

  const applied = sanitizeSessionId(headerGet(input.appliedHeaders, SESSION_HEADER));
  if (applied) return applied;

  const seed = deriveContentSessionSeed(input.body);
  if (seed) return seed;

  if (input.allowGenerate && typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return '';
}

/**
 * Apply the OpenCode identity headers to an outbound request.
 *
 * Called after buildUpstreamHeaders so an operator-configured client_spoofing
 * User-Agent keeps the final say, matching sub2api's header-override rule.
 * Returns nothing; mutates the header map in place.
 */
export function applyOpenCodeHeaders(
  headers: Record<string, string>,
  input: OpenCodeHeaderInput
): void {
  // User-Agent: only fill the gap. An explicit spoofing preset or a JSON
  // override already written into `headers` wins.
  let hasUserAgent = false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'user-agent') {
      hasUserAgent = true;
      if (!String(headers[key] || '').trim()) delete headers[key];
      else break;
    }
  }
  if (!hasUserAgent) {
    headers['user-agent'] = OPENCODE_UPSTREAM_USER_AGENT;
  }

  const sessionId = resolveOpenCodeSessionId({ ...input, appliedHeaders: headers });
  if (!sessionId) return;

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) delete headers[key];
  }
  headers[SESSION_HEADER] = sessionId;
}

/**
 * Probe calls carry no client and no body worth parsing for hints, but still
 * need a session header, so the probe mints its own UUID-backed value.
 */
export function applyOpenCodeProbeHeaders(headers: Record<string, string>): void {
  applyOpenCodeHeaders(headers, { allowGenerate: true });
}
