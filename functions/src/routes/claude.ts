// Claude Messages route handler
import type { Env } from '../index';
import { createDatabase } from '../db';
import { authenticateApiKey } from '../auth';
import { FailoverManager } from '../failover';
import { proxyRequest, buildUpstreamHeaders, getUpstreamBaseUrl, findModelMapping, resolveUpstreamCredentials , accountRateMultiplier, stripBodyHeaders } from '../utils/proxy';
import { applyOpenCodeHeaders, resolveOpenCodeSessionId } from '../utils/opencode-session';
import { streamWithRecording } from '../utils/record';
import { scheduleUsageRefresh } from '../utils/usage-refresh';
import { envInt, retryDelayMs, retryBudgetExceeded, sleep } from '../utils/retry';
import { applyAnthropicCacheBreakpoints } from '../utils/cache-breakpoints';
import { sanitizeToolSchemas } from '../utils/responses-compat';
import { defer, Deferrable } from '../utils/background';
import { getModelFromHeader } from '../utils/headers';
import { extractTokenUsage, calculateCostBreakdown, estimateTokens, extractReasoningEffort } from '../billing';
import { Account, Group, ModelMapping } from '../types';
import { modelAllowed, modelAllowlistDenied } from '../utils/model-allowlist';
import { loadRoutingSnapshot } from '../utils/routing-cache';

export async function handleClaudeRequest(request: Request, env: Env, failover: FailoverManager, ctx?: Deferrable, requestId = ''): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  
  // Extract API key
  const authHeader = request.headers.get('authorization');
  const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : request.headers.get('x-api-key');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  
  const keyRecord = await authenticateApiKey(db, apiKey);
  if (!keyRecord) {
    return new Response(JSON.stringify({ error: 'Invalid or disabled API key' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  
  // Get request body
  const body = await request.text();
  let requestBody: any;
  try {
    requestBody = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  
  const model = requestBody.model || getModelFromHeader(request) || '';
  const stream = requestBody.stream === true;
  // Claude Code probes the token-count preflight constantly. Rewriting it to
  // /v1/messages (the hardcoded upstream path below) made every call fail —
  // or worse, generate —so it gets its own endpoint and bookkeeping rules.
  const isCountTokens = url.pathname.replace(/\/+$/, '').endsWith('/v1/messages/count_tokens');
  // Session→account pin for sticky routing; see gateway.ts.
  const stickyKey = resolveOpenCodeSessionId({ clientHeaders: request.headers, body: requestBody, allowGenerate: false }) || undefined;
  const userAgent = request.headers.get('user-agent')?.slice(0, 255) || null;
  const reasoningEffort = extractReasoningEffort(requestBody);
  
  // Get Anthropic-protocol accounts. OpenCode Go is included because its
  // MiniMax and Qwen models are natively served on the Anthropic endpoint.
  const routing = await loadRoutingSnapshot(db, failover);
  let accounts = routing.accounts;
  accounts = accounts.filter(a => (a.provider === 'anthropic' || a.provider === 'opencode_go') && a.enabled);

  // A client key may be pinned to one group. That is a hard constraint: serving
  // it from another group would bill and route traffic somewhere the operator
  // deliberately excluded, so an empty result fails instead of falling back.
  const keyGroupId = Number(keyRecord?.group_id) || 0;
  const fallbackGroupId = Number(keyRecord?.fallback_group_id) || 0;
  if (keyGroupId) {
    accounts = accounts.filter(account => Number(account.group_id) === keyGroupId || Number(account.group_id) === fallbackGroupId);
    if (accounts.length === 0) {
      if (isCountTokens) return localCountTokensResponse(requestBody);
      return new Response(JSON.stringify({
        error: 'No available accounts',
        message: '该 API 密钥绑定的主分组和兜底分组下没有可用账号'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  if (accounts.length === 0) {
    if (isCountTokens) return localCountTokensResponse(requestBody);
    return new Response(JSON.stringify({ error: 'No available Anthropic-compatible accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  // Load supporting data
  const groups = new Map(routing.groups.map(g => [g.id, g]));
  const mappings = routing.mappings;

  // The key's group may pin a model allowlist: denying here (404, before any
  // account is picked) keeps a listed-out model from being generated at all
  // (Go: group_model_allowlist.go).
  if (keyGroupId && !modelAllowed(model, groups.get(keyGroupId))) {
    return modelAllowlistDenied(model);
  }
  
  // Apply model mapping
  const mapping = findModelMapping(model, mappings, 'anthropic') || findModelMapping(model, mappings, 'opencode_go');
  // A mapping may pin this request to one of the route's providers; other
  // providers (an OpenAI-targeted mapping, say) leave the pool untouched.
  if (mapping && (mapping.provider === 'anthropic' || mapping.provider === 'opencode_go')) {
    accounts = accounts.filter(account => account.provider === mapping.provider);
  }
  if (accounts.length === 0) {
    if (isCountTokens) return localCountTokensResponse(requestBody);
    return new Response(JSON.stringify({ error: 'No available accounts for requested model' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  let upstreamModel = mapping?.requested_model.endsWith('*')
    ? mapping.upstream_model + model.slice(mapping.requested_model.length - 1)
    : (mapping?.upstream_model || model);
  const preferredGroupId = keyGroupId || mapping?.group_id || undefined;
  
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  
  // Select account with failover
  const selection = await failover.selectAccount(accounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : [], { stickyKey });
  if (!selection) {
    if (isCountTokens) return localCountTokensResponse(requestBody);
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { account, group } = selection;
  const provider = account.provider;
  scheduleUsageRefresh(account, env, ctx);

  // OpenCode's Anthropic-compatible layer exposes no count_tokens endpoint:
  // forwarding it only 404s and —worse —feeds the failure into account
  // health. The count is answered locally instead, before any upstream work.
  if (isCountTokens && provider === 'opencode_go') {
    return localCountTokensResponse(requestBody);
  }

  // Anthropic prompt caching only helps if the client marks cacheable
  // breakpoints; most third-party clients omit them. Inject them when the
  // body has none so prefix reuse happens without client cooperation.
  if (provider === 'anthropic' && (env.CACHE_BREAKPOINTS ?? '1') !== '0') {
    applyAnthropicCacheBreakpoints(requestBody);
  }

  // Proactive tool-schema sanitation before the first attempt: this route
  // speaks the Anthropic protocol (tools[].input_schema) where Go repairs
  // root types but never touches `pattern` —lookaround removal stays
  // OpenAI-only, so the option is omitted here.
  sanitizeToolSchemas(requestBody);

  // Build upstream request
  const credentials = resolveUpstreamCredentials(account);
  const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, provider);
  const upstreamPath = isCountTokens ? '/v1/messages/count_tokens' : '/v1/messages';
  // ?beta=true is Anthropic's own flag; OpenCode's Anthropic-protocol endpoint
  // is called without it upstream, so it is not appended there.
  const upstreamUrl = provider === 'opencode_go'
    ? `${baseUrl}${upstreamPath}`
    : `${baseUrl}${upstreamPath}?beta=true`;
  const headers = buildUpstreamHeaders(request.headers, provider, credentials.apiKey, credentials.baseUrl, account.client_spoofing);
  if (provider === 'opencode_go') {
    applyOpenCodeHeaders(headers, { clientHeaders: request.headers, body: requestBody, allowGenerate: true });
  }
  
  const startTime = Date.now();
  
  try {
    const proxyResponse = await proxyRequest({
      url: upstreamUrl,
      method: request.method,
      headers,
      signal: request.signal,
      timeoutMs: envInt(env.UPSTREAM_HEADER_TIMEOUT_MS, 60000),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody)));
          controller.close();
        }
      })
    });
    
    const isError = proxyResponse.status >= 400;

    // count_tokens is a free advisory preflight, not a generation. Its answer
    // (or a local estimate when the relay lacks the endpoint) passes straight
    // through: never billed, never written to account health —a relay without
    // /count_tokens would otherwise trip the circuit breaker for everyone
    // while Claude Code kept probing it. A real failure surfaces on the very
    // next /v1/messages call, which fails over normally.
    if (isCountTokens) {
      const countText = await proxyResponse.text().catch(() => '');
      if (proxyResponse.status === 404 || proxyResponse.status === 405) {
        return localCountTokensResponse(requestBody);
      }
      if (failover.shouldFailover({ status: proxyResponse.status })) {
        // Account-level failure: rotate through the same retry loop, which
        // writes no health for a preflight; with no candidate left its
        // exhaustion fallback answers with an estimate.
        return handleClaudeFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), groups, mappings, upstreamModel, stream, `count_tokens upstream ${proxyResponse.status}`, preferredGroupId, startTime, ctx, fallbackGroupId, stickyKey, isCountTokens, requestId);
      }
      return new Response(countText, {
        status: proxyResponse.status,
        headers: {
          ...stripBodyHeaders(proxyResponse.headers),
          'content-type': proxyResponse.headers['content-type'] || 'application/json',
          'cache-control': 'no-store, no-transform'
        }
      });
    }

    if (isError && failover.shouldFailover({ status: proxyResponse.status })) {
      failover.noteRateLimit(account.id, proxyResponse.status, proxyResponse.headers['retry-after']);
    }
    if (isError && failover.shouldFailover({ status: proxyResponse.status }) && accounts.length > 1) {
      await proxyResponse.text().catch(() => '');
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: `Upstream returned ${proxyResponse.status}`, latency_ms: Date.now() - startTime, request_id: requestId }));
      return handleClaudeFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), groups, mappings, upstreamModel, stream, `Upstream returned ${proxyResponse.status}`, preferredGroupId, startTime, ctx, fallbackGroupId, stickyKey, undefined, requestId);
    }
    if (stream && proxyResponse.body) {
      // Streaming records usage from the stream's completion callback so
      // first-byte latency is not delayed by bookkeeping. Awaited so a
      // first-output stall is caught here and failed over.
      return await streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
        db, failover, keyRecordId: keyRecord.id,
        accountId: account.id, groupId: group.id,
        provider, model: upstreamModel,
        rateMultiplier: accountRateMultiplier(account),
        startedAt: startTime,
        reasoningEffort,
        userAgent,
        ctx,
        env,
        requestId
      });
    }
    const responseText = await proxyResponse.text();
    let responseBody: any = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Non-JSON response
    }
    
    // The estimation fallback needs the request body; a failed attempt bills nothing.
    const { promptTokens, completionTokens, totalTokens, cacheReadTokens } = extractTokenUsage(responseBody, proxyResponse.headers, isError ? undefined : requestBody);
    const breakdown = calculateCostBreakdown(provider, upstreamModel, promptTokens, completionTokens, accountRateMultiplier(account));
    const cost = breakdown.cost;
    
    // Record usage
    if (cost > 0) {
      defer(ctx, db.incrementApiKeyUsage(keyRecord.id, cost));
    }
    defer(ctx, db.createUsageRecord({ api_key_id: keyRecord.id, group_id: group.id, account_id: account.id, model: upstreamModel, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cache_read_tokens: cacheReadTokens, cost, base_cost: breakdown.baseCost, rate_multiplier: breakdown.multiplier, cost_estimated: breakdown.estimated ? 1 : 0, cache_status: 'bypass', status: proxyResponse.status, error_message: isError ? responseBody?.error?.message || 'Error' : '', latency_ms: Date.now() - startTime, reasoning_effort: reasoningEffort, user_agent: userAgent, request_id: requestId }));
    
    // Record request log
    defer(ctx, db.createRequestLog({
      account_id: account.id,
      group_id: group.id,
      model: upstreamModel,
      status: proxyResponse.status,
      error_message: isError ? responseBody?.error?.message || 'Error' : '',
      latency_ms: Date.now() - startTime,
      request_id: requestId
    }));
    
    // Record for failover
    failover.recordRequest(account.id, group.id, isError);
    
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        // The body was read back as text, so upstream framing headers no
        // longer describe the bytes being sent.
        ...stripBodyHeaders(proxyResponse.headers),
        'content-type': 'application/json', 'cache-control': 'no-store, no-transform'
      }
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`claude attempt failed [${requestId}] account=${account.id} model=${upstreamModel}: ${errorMessage}`);
    // A preflight's transport error must not mark the account unhealthy —
    // Claude Code probes count_tokens far more often than it generates, and
    // a flaky preflight would open the breaker for real traffic.
    if (!isCountTokens) {
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime, request_id: requestId }));
    }
    
    // Try failover
    return handleClaudeFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), groups, mappings, upstreamModel, stream, errorMessage, preferredGroupId, startTime, ctx, fallbackGroupId, stickyKey, isCountTokens, requestId);
  }
}

// Claude-specific failover
async function handleClaudeFailover(
  body: string,
  request: Request,
  env: Env,
  failover: FailoverManager,
  keyRecord: any,
  accounts: Account[],
  groups: Map<number, Group>,
  mappings: ModelMapping[],
  upstreamModel: string,
  stream: boolean,
  errorMessage: string,
  preferredGroupId?: number,
  originStart: number = Date.now(),
  ctx?: Deferrable,
  fallbackGroupId = 0,
  stickyKey?: string,
  isCountTokens = false,
  requestId = ''
): Promise<Response> {
  const db = createDatabase(env.DB);
  const userAgent = request.headers.get('user-agent')?.slice(0, 255) || null;
  let requestMetaBody: any;
  try { requestMetaBody = JSON.parse(body); } catch { requestMetaBody = undefined; }
  const reasoningEffort = extractReasoningEffort(requestMetaBody);
  
  const attempted = new Set<number>();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    // Client hangups and exhausted budgets stop the chain immediately: another
    // attempt can only burn quota nobody is left to read.
    if (request.signal?.aborted) break;
    if (retryBudgetExceeded(originStart, env)) break;
    await sleep(retryDelayMs(i + 1, env), request.signal);
    if (request.signal?.aborted) break;
    const nextAccounts = accounts.filter(a => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : [], { stickyKey });
    
    if (!selection) break;
    
    const { account, group } = selection;
    attempted.add(account.id);
    scheduleUsageRefresh(account, env, ctx);
    const currentProvider = account.provider;
    // Keep the conversation id stable across OpenCode retries.
    let retryBody: unknown;
    try { retryBody = JSON.parse(body); } catch { retryBody = undefined; }

    // A preflight that landed on an OpenCode account is answered locally —
    // same rule as the main path, before any upstream call.
    if (isCountTokens && currentProvider === 'opencode_go') {
      return localCountTokensResponse(retryBody);
    }
    
    try {
      const credentials = resolveUpstreamCredentials(account);
      const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, currentProvider);
      const retryPath = isCountTokens ? '/v1/messages/count_tokens' : '/v1/messages';
      const upstreamUrl = currentProvider === 'opencode_go'
        ? `${baseUrl}${retryPath}`
        : `${baseUrl}${retryPath}?beta=true`;
      const headers = buildUpstreamHeaders(request.headers, currentProvider, credentials.apiKey, credentials.baseUrl, account.client_spoofing);
      if (currentProvider === 'opencode_go') {
        applyOpenCodeHeaders(headers, { clientHeaders: request.headers, body: retryBody, allowGenerate: true });
      }
      const proxyResponse = await proxyRequest({
        url: upstreamUrl,
        method: request.method,
        headers,
        signal: request.signal,
        timeoutMs: envInt(env.UPSTREAM_HEADER_TIMEOUT_MS, 60000),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          }
        })
      });
      
      const isError = proxyResponse.status >= 400;

      // Advisory preflight rules again: no cooldowns, no health writes, no
      // billing. An unsupported endpoint becomes a local estimate; anything
      // else passes through (rotating accounts only for account-level
      // failures, mirroring the loop below without touching health).
      if (isCountTokens) {
        const countText = await proxyResponse.text().catch(() => '');
        if (proxyResponse.status === 404 || proxyResponse.status === 405) {
          return localCountTokensResponse(retryBody);
        }
        if (isError && failover.shouldFailover({ status: proxyResponse.status })) {
          // Rotate only while another candidate exists; otherwise the
          // preflight still owes the client a number, so estimate here
          // rather than surfacing this account's transient failure.
          const hasMore = accounts.some(candidate => candidate.enabled && !attempted.has(candidate.id));
          if (hasMore && i < maxRetries - 1) continue;
          return localCountTokensResponse(retryBody);
        }
        return new Response(countText, {
          status: proxyResponse.status,
          headers: {
            ...stripBodyHeaders(proxyResponse.headers),
            'content-type': proxyResponse.headers['content-type'] || 'application/json',
            'cache-control': 'no-store, no-transform'
          }
        });
      }

      if (isError && failover.shouldFailover({ status: proxyResponse.status })) {
        failover.noteRateLimit(account.id, proxyResponse.status, proxyResponse.headers['retry-after']);
        if (i < maxRetries - 1) {
          failover.recordRequest(account.id, group.id, true);
          continue;
        }
      }
      
      // Streaming records its own request log and usage from the stream
      // completion callback, so return before the non-streaming bookkeeping.
      if (stream && !isError && proxyResponse.body) {
        return await streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
          db, failover, keyRecordId: keyRecord.id,
          accountId: account.id, groupId: group.id,
          provider: currentProvider, model: upstreamModel,
          rateMultiplier: accountRateMultiplier(account),
          startedAt: originStart,
          reasoningEffort,
          userAgent,
          ctx,
          env,
          requestId
        });
      }

      failover.recordRequest(account.id, group.id, isError);
      defer(ctx, db.createRequestLog({
        account_id: account.id,
        group_id: group.id,
        model: upstreamModel,
        status: proxyResponse.status,
        error_message: isError ? errorMessage : '',
        latency_ms: 0,
        request_id: requestId
      }));
      const responseText = await proxyResponse.text();

      // The successful retry served real tokens; bill it exactly as the main
      // path does, or every failed-over call vanishes from quota accounting.
      let retryResponseBody: any = {};
      try { retryResponseBody = JSON.parse(responseText); } catch { /* non-JSON */ }
      const usage = extractTokenUsage(retryResponseBody, proxyResponse.headers, isError ? undefined : requestMetaBody);
      const retryBreakdown = calculateCostBreakdown(currentProvider, upstreamModel, usage.promptTokens, usage.completionTokens, accountRateMultiplier(account));
      if (retryBreakdown.cost > 0) {
        defer(ctx, db.incrementApiKeyUsage(keyRecord.id, retryBreakdown.cost));
      }
      defer(ctx, db.createUsageRecord({ api_key_id: keyRecord.id, group_id: group.id, account_id: account.id, model: upstreamModel, provider: currentProvider, prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, cache_read_tokens: usage.cacheReadTokens, cost: retryBreakdown.cost, base_cost: retryBreakdown.baseCost, rate_multiplier: retryBreakdown.multiplier, cost_estimated: retryBreakdown.estimated ? 1 : 0, cache_status: 'bypass', status: proxyResponse.status, error_message: isError ? retryResponseBody?.error?.message || errorMessage : '', latency_ms: Date.now() - originStart, reasoning_effort: reasoningEffort, user_agent: userAgent, request_id: requestId }));

      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...stripBodyHeaders(proxyResponse.headers), 'content-type': 'application/json', 'cache-control': 'no-store, no-transform' }
      });
      
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : 'Upstream request failed';
      // Same rule as the main path: a preflight's transport error rotates
      // accounts but never writes health or logs.
      if (!isCountTokens) {
        console.error(`claude retry failed [${requestId}] account=${account.id} model=${upstreamModel}: ${retryMessage}`);
        failover.recordRequest(account.id, group.id, true);
        defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryMessage, latency_ms: 0, request_id: requestId }));
      }
      continue;
    }
  }
  
  // All retries failed. A preflight still owes the client a number —Claude
  // Code sizes context against it —so it degrades to a local estimate
  // instead of an error the client would have to work around.
  if (isCountTokens) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = undefined; }
    return localCountTokensResponse(parsed);
  }
  console.error(`claude request exhausted [${requestId}] model=${upstreamModel}: ${errorMessage}`);
  return new Response(JSON.stringify({ error: 'All Anthropic accounts failed', message: errorMessage }), { status: 502, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Local answer for /v1/messages/count_tokens when no upstream can serve it.
 * The estimator weights CJK and ASCII differently and rounds up: Anthropic's
 * own counter never answers with 0, and a 0 would tell a client its context
 * is empty.
 */
function countTokensEstimate(body: any): number {
  return Math.max(1, estimateTokens(JSON.stringify(body ?? {})));
}

function localCountTokensResponse(body: any): Response {
  return new Response(JSON.stringify({ input_tokens: countTokensEstimate(body) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' }
  });
}
