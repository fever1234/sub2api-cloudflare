/** Bindings available to the Pages Function worker. */
export interface Env {
  DB: D1Database;
  CONFIG_KV?: KVNamespace;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  JWT_SECRET?: string;
  API_KEY_ENCRYPTION_KEY?: string;
  ERROR_RATE_THRESHOLD?: string;
  ERROR_COUNT_THRESHOLD?: string;
  WINDOW_SECONDS?: string;
  MAX_SAME_ACCOUNT_RETRIES?: string;
  /** Milliseconds to wait for upstream response headers before aborting. */
  UPSTREAM_HEADER_TIMEOUT_MS?: string;
  /** Milliseconds before the first upstream stream byte counts as a stall. */
  STREAM_FIRST_OUTPUT_TIMEOUT_MS?: string;
  /** Milliseconds of silence mid-stream before the stream is failed. */
  STREAM_IDLE_TIMEOUT_MS?: string;
  /** Interval for SSE `: ping` keepalive comments while the client is idle. */
  STREAM_KEEPALIVE_INTERVAL_MS?: string;
  /** Hard ceiling on a single streamed response. */
  STREAM_TOTAL_TIMEOUT_MS?: string;
  /** Base delay for exponential backoff between account retries. */
  RETRY_BASE_DELAY_MS?: string;
  /** Cap for a single backoff delay. */
  RETRY_MAX_DELAY_MS?: string;
  /** Wall-clock budget across all retry attempts of one request. */
  RETRY_BUDGET_MS?: string;
  /** Default cooldown after a 429 without Retry-After. 0 disables cooldowns. */
  RATE_LIMIT_COOLDOWN_MS?: string;
  /** How long a failed health probe keeps demoting an account. */
  PROBE_FAIL_TTL_MS?: string;
  /** '0' disables sticky session→account routing. */
  SESSION_STICKY?: string;
  /** '0' disables Anthropic cache_control breakpoint injection. */
  CACHE_BREAKPOINTS?: string;
  /** Retention for usage_records/request_logs in days. '0' disables cleanup. */
  USAGE_RETENTION_DAYS?: string;
}
