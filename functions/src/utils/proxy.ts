// Proxy utilities for forwarding requests to upstream providers
import { ProxyRequest, ProxyResponse, ModelMapping } from '../types';
import { envInt } from './retry';

export async function proxyRequest(request: ProxyRequest): Promise<ProxyResponse> {
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : 60000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // The client hanging up must tear down the upstream fetch too, so the
  // isolate stops paying for a stream nobody is reading.
  const clientSignal = request.signal;
  const onClientAbort = () => controller.abort();
  const detach = () => {
    clearTimeout(timeout);
    clientSignal?.removeEventListener('abort', onClientAbort);
  };
  if (clientSignal) {
    if (clientSignal.aborted) {
      detach();
      throw new Error('client disconnected');
    }
    clientSignal.addEventListener('abort', onClientAbort, { once: true });
  }

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers as any,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'follow',
      signal: controller.signal
    });

    detach();

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: response.status,
      headers,
      body: response.body!,
      text: () => response.text()
    };
  } catch (error) {
    detach();
    if (timedOut) {
      throw new Error(`upstream did not send response headers within ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * Header names that describe the upstream body's framing, which no longer
 * apply once the body has been converted or re-serialized (the chat⇄responses
 * bridge, JSON pretty-printing). Forwarding a stale `content-length` makes the
 * client truncate or hang; forwarding `content-encoding` claims bytes that are
 * not there.
 */
export function stripBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'content-encoding' || lower === 'transfer-encoding') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Force `stream_options.include_usage` on an OpenAI-protocol chat body.
 *
 * A streaming Chat Completions response only carries a `usage` frame when the
 * client asked for one, so a client that streams without it would make the
 * gateway record the request at zero tokens and never touch the key's quota.
 * The upstream is asked unconditionally — even over an explicit
 * `include_usage: false` — and the extra frame travels downstream untouched,
 * which is how the original gateway keeps streaming billing complete.
 *
 * Returns true only when the body actually changed, so a caller that may replay
 * original request bytes knows when re-serialization is required.
 */
export function ensureChatStreamUsage(body: any): boolean {
  if (!body || typeof body !== 'object') return false;
  const options = body.stream_options && typeof body.stream_options === 'object' && !Array.isArray(body.stream_options)
    ? body.stream_options
    : {};
  if (options.include_usage === true) return false;
  body.stream_options = { ...options, include_usage: true };
  return true;
}

export function buildUpstreamHeaders(
  originalHeaders: Headers,
  provider: string,
  apiKey: string,
  baseUrl?: string,
  clientSpoofing?: string
): Record<string, string> {
  const headers: Record<string, string> = {};
  
  // Copy relevant headers
  const preserveHeaders = [
    'content-type',
    'anthropic-version',
    'anthropic-beta',
    'x-api-key',
    'authorization'
  ];
  
  originalHeaders.forEach((value, key) => {
    if (preserveHeaders.includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  
  // Provider-specific headers
  switch (provider) {
    case 'anthropic':
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
      headers['anthropic-beta'] = headers['anthropic-beta'] || 'prompt-caching-2024-12-16,code-execution-2025-05-14';
      delete headers['authorization'];
      break;
    case 'openai':
      headers['authorization'] = `Bearer ${apiKey}`;
      break;
    case 'xai':
      headers['authorization'] = `Bearer ${apiKey}`;
      break;
    case 'opencode_go':
      // OpenCode authenticates with Authorization: Bearer on every endpoint,
      // including the Anthropic-protocol one. A client's own x-api-key is the
      // gateway credential and must not travel upstream.
      headers['authorization'] = `Bearer ${apiKey}`;
      delete headers['x-api-key'];
      break;
    default:
      headers['authorization'] = `Bearer ${apiKey}`;
  }
  
  // Apply client spoofing
  applyClientSpoofing(headers, provider, clientSpoofing);
  
  // Remove host header (will be set by fetch)
  delete headers['host'];
  delete headers['cf-connecting-ip'];
  delete headers['cf-ray'];
  delete headers['cf-visitor'];
  delete headers['x-forwarded-for'];
  
  return headers;
}

// Client spoofing presets
const CLIENT_SPOOFING_PRESETS: Record<string, Record<string, string>> = {
  'codex': {
    'user-agent': 'Codex CLI/0.1.0',
    'x-client-name': 'openai-cli',
    'x-client-version': '0.1.0'
  },
  'codex-ws': {
    'user-agent': 'Codex CLI/0.1.0 (WebSocket)',
    'x-client-name': 'openai-cli',
    'x-client-version': '0.1.0'
  },
  'claude-code': {
    'user-agent': 'claude-cli/1.0',
    'anthropic-beta': 'code-execution-2025-05-14,computer-use-2025-07-15'
  },
  'claude-code-ws': {
    'user-agent': 'claude-cli/1.0',
    'anthropic-beta': 'code-execution-2025-05-14,computer-use-2025-07-15,web-search-2025-07-15'
  },
  'grok': {
    'user-agent': 'xAI-Grok/1.0',
    'x-client-name': 'grok-cli',
    'x-client-version': '1.0'
  }
};

function applyClientSpoofing(headers: Record<string, string>, provider: string, clientSpoofing?: string): void {
  if (!clientSpoofing || clientSpoofing.trim() === '') {
    return;
  }
  
  // Check if it's a preset
  const preset = CLIENT_SPOOFING_PRESETS[clientSpoofing.toLowerCase()];
  if (preset) {
    for (const [key, value] of Object.entries(preset)) {
      // Skip anthropic-beta for non-anthropic providers
      if (key === 'anthropic-beta' && provider !== 'anthropic') {
        continue;
      }
      headers[key] = value;
    }
    return;
  }
  
  // Try to parse as JSON
  try {
    const customHeaders = JSON.parse(clientSpoofing);
    if (typeof customHeaders === 'object' && customHeaders !== null) {
      for (const [key, value] of Object.entries(customHeaders)) {
        if (typeof value === 'string') {
          headers[key] = value;
        }
      }
    }
  } catch {
    // Invalid JSON, ignore
  }
}

/**
 * Resolve the credentials a request should actually use. An account may leave
 * An account carries its own key and base URL. A blank base URL means the
 * default is applied later by getUpstreamBaseUrl.
 */
export function resolveUpstreamCredentials(
  account: { api_key?: string; base_url?: string }
): { apiKey: string; baseUrl: string } {
  return {
    apiKey: String(account?.api_key || '').trim(),
    baseUrl: String(account?.base_url || '').trim()
  };
}

/** Watchdog budgets for a streamed upstream response. */
export interface StreamGuard {
  /** No first byte within this window fails the attempt as a stall. */
  firstOutputTimeoutMs: number;
  /** No byte mid-stream within this window fails the stream. */
  idleTimeoutMs: number;
  /** SSE keepalive comment interval while the client is idle. */
  keepaliveIntervalMs: number;
  /** Hard ceiling for one streamed response. */
  totalTimeoutMs: number;
}

export function streamGuardFromEnv(env: {
  STREAM_FIRST_OUTPUT_TIMEOUT_MS?: string;
  STREAM_IDLE_TIMEOUT_MS?: string;
  STREAM_KEEPALIVE_INTERVAL_MS?: string;
  STREAM_TOTAL_TIMEOUT_MS?: string;
}): StreamGuard {
  return {
    firstOutputTimeoutMs: envInt(env.STREAM_FIRST_OUTPUT_TIMEOUT_MS, 180000),
    idleTimeoutMs: envInt(env.STREAM_IDLE_TIMEOUT_MS, 180000),
    keepaliveIntervalMs: envInt(env.STREAM_KEEPALIVE_INTERVAL_MS, 15000),
    totalTimeoutMs: envInt(env.STREAM_TOTAL_TIMEOUT_MS, 1800000)
  };
}

/**
 * A mid-stream upstream stall. Carries status 0 so `shouldFailover` treats it
 * like a network failure and moves to the next account when nothing has been
 * written to the client yet.
 */
export class UpstreamStallError extends Error {
  status = 0;
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamStallError';
  }
}

/**
 * Wait for the first upstream byte before the response is handed to the
 * client. A stream that opens but never sends anything (a wedged upstream,
 * a proxy holding the connection) used to look "successful" and could not be
 * failed over, because once the Response exists the attempt is committed.
 * Reading the first chunk up front keeps that decision reversible: any stall
 * here throws before the caller has answered, so failover still applies.
 *
 * The staged chunk is re-attached to the front of the stream so downstream
 * consumers see one continuous byte sequence.
 */
export async function stageFirstChunk(
  body: ReadableStream<Uint8Array>,
  guard: StreamGuard
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new UpstreamStallError(`upstream sent no data within ${guard.firstOutputTimeoutMs}ms`)),
          guard.firstOutputTimeoutMs
        );
      })
    ]);
    if (timer) clearTimeout(timer);
    if (first.done) {
      throw new UpstreamStallError('upstream stream ended before the first byte');
    }
    const firstChunk = first.value;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstChunk);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
      }
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export interface StreamOutcome {
  /** Milliseconds until the first upstream byte reached the client. */
  ttftMs: number | null;
  /** Milliseconds until the upstream closed the stream. */
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Forward a stream untouched while observing timing, token usage and
 * liveness.
 *
 * Time to first token decides whether a client feels responsive, so it must be
 * measured without buffering: every chunk is enqueued immediately and only
 * timestamped on the way past. Buffering to measure would inflate the very
 * number being measured.
 *
 * Providers report usage in a late SSE frame (`message_delta` for Anthropic, a
 * final `usage` chunk for OpenAI). Rather than retain the whole transcript, only
 * a small rolling tail is kept so a usage object split across two chunks is
 * still parsed. `onDone` runs when the stream settles — close, error or cancel
 * — so the caller can log without delaying delivery. Unlike a TransformStream
 * flush, the error path also settles, which is what releases the post-response
 * bookkeeping when an upstream dies mid-stream.
 *
 * With a guard the pump also enforces the stream liveness contract: an idle
 * window and a total ceiling fail the stream, and SSE responses get `: ping`
 * comments so intermediaries do not drop a connection whose model is simply
 * thinking. Keepalives change the byte count, which is why body framing headers
 * must not be forwarded alongside them.
 */
export function measureStreamTiming(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  onDone: (outcome: StreamOutcome) => void,
  guard?: StreamGuard,
  keepalive = false
): ReadableStream<Uint8Array> {
  let ttftMs: number | null = null;
  let settled = false;
  let tail = '';
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const decoder = new TextDecoder();

  // Enough to hold a usage frame that straddles a chunk boundary, small enough
  // that a long conversation never accumulates memory in the isolate.
  const TAIL_LIMIT = 4096;

  const scan = (text: string) => {
    tail = (tail + text).slice(-TAIL_LIMIT);
    // Match both OpenAI (prompt_tokens/completion_tokens) and Anthropic
    // (input_tokens/output_tokens) spellings wherever they appear.
    const prompt = /"(?:prompt_tokens|input_tokens)"\s*:\s*(\d+)/g;
    const completion = /"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/g;
    const total = /"total_tokens"\s*:\s*(\d+)/g;
    for (let m = prompt.exec(tail); m; m = prompt.exec(tail)) {
      usage.promptTokens = Math.max(usage.promptTokens, Number(m[1]) || 0);
    }
    for (let m = completion.exec(tail); m; m = completion.exec(tail)) {
      // Anthropic emits a running output count, so the largest seen wins.
      usage.completionTokens = Math.max(usage.completionTokens, Number(m[1]) || 0);
    }
    for (let m = total.exec(tail); m; m = total.exec(tail)) {
      usage.totalTokens = Math.max(usage.totalTokens, Number(m[1]) || 0);
    }
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    try {
      onDone({
        ttftMs,
        totalMs: Date.now() - startedAt,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens || usage.promptTokens + usage.completionTokens
      });
    } catch {
      // Never let logging break the response the client is reading.
    }
  };

  const reader = body.getReader();
  const encoder = new TextEncoder();
  const PING = encoder.encode(': ping\n\n');
  const idleMs = guard?.idleTimeoutMs ?? 0;
  const totalMs = guard?.totalTimeoutMs ?? 0;
  const keepaliveMs = keepalive ? (guard?.keepaliveIntervalMs ?? 0) : 0;
  let lastClientSend = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let keepTimer: ReturnType<typeof setInterval> | undefined;
  // Set once a watchdog or the caller tears the stream down, so a read that
  // resolves afterwards does not double-close or re-scan.
  let failed = false;

  const clearTimers = () => {
    clearTimeout(idleTimer ?? null);
    clearTimeout(totalTimer ?? null);
    clearInterval(keepTimer ?? null);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (failed) return;
      const fail = (message: string) => {
        if (failed) return;
        failed = true;
        clearTimers();
        finish();
        try {
          controller.error(new UpstreamStallError(message));
        } catch {
          // Controller already closed by the runtime.
        }
      };
      if (totalMs > 0 && totalTimer === undefined) {
        totalTimer = setTimeout(() => fail(`upstream stream exceeded ${totalMs}ms`), totalMs);
      }
      if (idleMs > 0) {
        idleTimer = setTimeout(() => fail(`upstream sent no data for ${idleMs}ms`), idleMs);
      }
      if (keepaliveMs > 0 && keepTimer === undefined) {
        keepTimer = setInterval(() => {
          if (failed || Date.now() - lastClientSend < keepaliveMs) return;
          try {
            // Best effort: the client may have gone away between reads.
            (controller as any).enqueue(PING);
            lastClientSend = Date.now();
          } catch {
            // Stream already closed; the read loop will notice on its own.
          }
        }, keepaliveMs);
      }

      try {
        const { done, value } = await reader.read();
        clearTimeout(idleTimer ?? null);
        if (failed) return;
        if (done) {
          clearTimers();
          finish();
          controller.close();
          return;
        }
        // Deliver first, measure second: the client must never wait on bookkeeping.
        controller.enqueue(value);
        lastClientSend = Date.now();
        if (ttftMs === null) ttftMs = Date.now() - startedAt;
        try {
          scan(decoder.decode(value, { stream: true }));
        } catch {
          // Binary or malformed frame; timing is still valid.
        }
      } catch (error) {
        if (failed) return;
        clearTimers();
        finish();
        try {
          controller.error(error);
        } catch {
          // Controller already closed by the runtime.
        }
      }
    },
    async cancel() {
      // The client disconnected mid-stream; still record what was observed.
      failed = true;
      clearTimers();
      finish();
      await reader.cancel().catch(() => {});
    }
  });
}

/**
 * Billing weight for an account; 1 when unset or invalid.
 *
 * A reseller upstream may bill at a fraction (or a premium) of list price, so
 * cost is the raw token price scaled by this factor.
 *
 * A null column has to be rejected before the numeric check, not by it, because
 * `Number(null)` is 0 — a legal weight meaning "free". A database row created
 * before rate_multiplier existed would otherwise bill at zero and, because this
 * value also breaks ties in account selection, sort as the cheapest upstream and
 * win every request. An explicit 0 is still honoured: a free upstream is real.
 */
export function accountRateMultiplier(account: any): number {
  const raw = account?.rate_multiplier;
  if (raw === null || raw === undefined || raw === '') return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

export function getUpstreamBaseUrl(baseUrl?: string, provider?: string): string {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (trimmed) {
    // The documented OpenCode base ends in /v1 while every call site appends
    // /v1/... itself, so one trailing segment is dropped: both …/zen/go and
    // …/zen/go/v1 resolve to the same upstream paths.
    if (provider === 'opencode_go') {
      return trimmed.replace(/\/v1$/, '');
    }
    return trimmed;
  }

  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'xai':
      return 'https://api.x.ai';
    case 'opencode_go':
      return 'https://opencode.ai/zen/go';
    case 'openai':
    default:
      return 'https://api.openai.com';
  }
}

export function mapModel(requestedModel: string, mappings: any[]): string {
  const mapping = findModelMapping(requestedModel, mappings);
  if (!mapping) return requestedModel;
  if (mapping.requested_model.endsWith('*')) {
    const prefix = mapping.requested_model.slice(0, -1);
    return mapping.upstream_model + requestedModel.slice(prefix.length);
  }
  return mapping.upstream_model;
}

/** Resolve the selected mapping so routing can also honor its target group. */
export function findModelMapping(
  requestedModel: string,
  mappings: ModelMapping[],
  provider?: string
): ModelMapping | null {
  const enabled = mappings
    .filter(mapping => mapping.enabled && (!provider || mapping.provider === provider))
    .sort((a, b) => (a.priority - b.priority) || (a.id - b.id));

  const exact = enabled.find(mapping => mapping.requested_model === requestedModel);
  if (exact) return exact;

  return enabled.find(mapping => {
    if (!mapping.requested_model.endsWith('*')) return false;
    return requestedModel.startsWith(mapping.requested_model.slice(0, -1));
  }) || null;
}
