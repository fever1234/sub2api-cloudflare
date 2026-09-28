// Main gateway handler - routes requests to appropriate provider
import type { Env } from '../index';
import { createDatabase } from '../db';
import { authenticateApiKey, hashApiKey } from '../auth';
import { FailoverManager } from '../failover';
import { proxyRequest, buildUpstreamHeaders, getUpstreamBaseUrl, findModelMapping, resolveUpstreamCredentials , accountRateMultiplier, stripBodyHeaders, ensureChatStreamUsage } from '../utils/proxy';
import { applyOpenCodeHeaders, resolveOpenCodeSessionId } from '../utils/opencode-session';
import { openCodeGoModelProtocol, chatCompletionsToResponses, responsesSseToChatStream, bufferResponsesSseAsChat } from '../utils/responses-bridge';
import { createStripRetryState, sendWithRejectedFieldRetry, type StripRetryState } from '../utils/responses-compat';
import { SilentRefusalDetector, guardSilentRefusalStream } from '../utils/silent-refusal';
import { modelAllowed, modelAllowlistDenied } from '../utils/model-allowlist';
import { streamWithRecording } from '../utils/record';
import { envInt, retryDelayMs, retryBudgetExceeded, sleep } from '../utils/retry';
import { applyAnthropicCacheBreakpoints } from '../utils/cache-breakpoints';
import { defer, Deferrable } from '../utils/background';
import { extractTokenUsage, calculateCostBreakdown, extractReasoningEffort } from '../billing';
import { Account, Group, ModelMapping } from '../types';
import { loadRoutingSnapshot } from '../utils/routing-cache';

export async function handleGatewayRequest(request: Request, env: Env, failover: FailoverManager, ctx?: Deferrable): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  
  // Extract API key from Authorization header
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  
  const apiKey = authHeader.slice(7);
  const keyRecord = await authenticateApiKey(db, apiKey);
  if (!keyRecord) {
    return new Response(JSON.stringify({ error: 'Invalid or disabled API key' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  
  // Get request body
  const body = await request.text();
  let requestBody: any;
  try {
    requestBody = body.trim() ? JSON.parse(body) : {};
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  
  const model = requestBody.model || '';
  const stream = requestBody.stream === true;
  // Sticky key for session→account routing: headers, then prompt_cache_key /
  // metadata.user_id, then a content seed. Resolved before any body mutation
  // so injected cache breakpoints never change it.
  const stickyKey = resolveOpenCodeSessionId({ clientHeaders: request.headers, body: requestBody, allowGenerate: false }) || undefined;
  const userAgent = request.headers.get('user-agent')?.slice(0, 255) || null;
  const reasoningEffort = extractReasoningEffort(requestBody);
  
  // Determine provider from model name or URL path
  let provider = 'openai';
  const pathLower = url.pathname.toLowerCase();
  
  if (pathLower.includes('/claude') || pathLower.includes('/anthropic') || model.startsWith('claude-')) {
    provider = 'anthropic';
  } else if (pathLower.includes('/grok') || model.startsWith('grok-')) {
    provider = 'xai';
  } else if (pathLower.includes('/openai') || pathLower.includes('/chat/completions') || pathLower.includes('/responses')) {
    provider = 'openai';
  }
  
  // Load all enabled accounts first; model mappings may refine the provider.
  const routing = await loadRoutingSnapshot(db, failover);
  let accounts = routing.accounts;
  
  // Load supporting data
  const groups = new Map(routing.groups.map(g => [g.id, g]));
  const mappings = routing.mappings;
  
  // Apply model mapping
  const mapping = findModelMapping(model, mappings);
  if (mapping?.provider) provider = mapping.provider;
  accounts = accounts.filter(a => a.provider === provider && a.enabled);

  // A client key may be pinned to one group. That is a hard constraint: serving
  // it from another group would bill and route traffic somewhere the operator
  // deliberately excluded, so an empty result fails instead of falling back.
  const keyGroupId = Number(keyRecord?.group_id) || 0;
  const fallbackGroupId = Number(keyRecord?.fallback_group_id) || 0;
  if (keyGroupId) {
    accounts = accounts.filter(account => Number(account.group_id) === keyGroupId || Number(account.group_id) === fallbackGroupId);
    if (accounts.length === 0) {
      return new Response(JSON.stringify({
        error: 'No available accounts',
        message: '该 API 密钥绑定的主分组和兜底分组下没有可用账号'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    // The key's group may pin a model allowlist: denying here (404, before any
    // account is picked) keeps a listed-out model from being generated at all
    // (Go: group_model_allowlist.go).
    if (!modelAllowed(model, groups.get(keyGroupId))) {
      return modelAllowlistDenied(model);
    }
  }
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  const providerMapping = mapping && mapping.provider === provider ? mapping : findModelMapping(model, mappings, provider);
  let upstreamModel = providerMapping?.requested_model.endsWith('*')
    ? providerMapping.upstream_model + model.slice(providerMapping.requested_model.length - 1)
    : (providerMapping?.upstream_model || model);
  const preferredGroupId = keyGroupId || providerMapping?.group_id || undefined;
  
  // Select account with failover
  const selection = await failover.selectAccount(accounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : [], { stickyKey });
  if (!selection) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { account, group, stats } = selection;
  
  // Build upstream URL
  const credentials = resolveUpstreamCredentials(account);
  const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, provider);
  let upstreamPath = url.pathname;
  
  // Map paths for different providers
  if (provider === 'anthropic') {
    // Ensure correct Anthropic path
    if (!upstreamPath.includes('/v1/messages')) {
      upstreamPath = '/v1/messages';
    }
  } else if (provider === 'openai' && upstreamPath.includes('/chat/completions')) {
    // Keep as is for OpenAI
  } else if (provider === 'xai') {
    // Grok uses OpenAI-compatible endpoints
    if (!upstreamPath.includes('/chat/completions')) {
      upstreamPath = '/v1/chat/completions';
    }
  } else if (provider === 'opencode_go') {
    // OpenCode Go serves exactly three protocol endpoints; anything else the
    // gateway sees falls back to its default chat-completions path.
    if (!upstreamPath.includes('/v1/messages') && !upstreamPath.includes('/chat/completions') && !upstreamPath.includes('/responses')) {
      upstreamPath = '/v1/chat/completions';
    }
  }

  // opencode_go responses-native models (muse-spark-*, grok-*, gpt-*) exist
  // only on /v1/responses: bridge a chat-completions request onto it so an
  // OpenAI-compatible client can still use them.
  let bridgedBody: string | undefined;
  if (provider === 'opencode_go' && request.method !== 'GET' && request.method !== 'HEAD'
      && !upstreamPath.includes('/responses') && !upstreamPath.includes('/v1/messages')
      && openCodeGoModelProtocol(upstreamModel) === 'responses') {
    if (upstreamModel && upstreamModel !== model && requestBody.model) {
      requestBody.model = upstreamModel;
    }
    try {
      bridgedBody = JSON.stringify(chatCompletionsToResponses(requestBody));
      upstreamPath = '/v1/responses';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request cannot be converted to the Responses API';
      return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code: null } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  // Chat Completions only emits a usage frame when stream_options.include_usage
  // is on, so a streaming client that omitted it would be billed at zero tokens.
  // The gateway asks on the client's behalf — but only for the OpenAI-protocol
  // chat endpoint: an Anthropic body would gain an unknown field, and a bridged
  // Responses body must stay a pure Responses body (its terminal event already
  // carries usage). A changed body is re-serialized below.
  let usageInjected = false;
  if (stream && bridgedBody === undefined
      && (provider === 'openai' || provider === 'xai' || provider === 'opencode_go')
      && upstreamPath.includes('/chat/completions')) {
    usageInjected = ensureChatStreamUsage(requestBody);
  }

  const upstreamUrl = new URL(`${baseUrl}${upstreamPath}`);
  if (provider === 'anthropic') upstreamUrl.searchParams.set('beta', 'true');
  
  // Build headers
  const headers = buildUpstreamHeaders(request.headers, provider, credentials.apiKey, credentials.baseUrl, account.client_spoofing);
  if (provider === 'opencode_go') {
    applyOpenCodeHeaders(headers, { clientHeaders: request.headers, body: requestBody, allowGenerate: true });
  }
  
  // Anthropic prompt caching only helps if the client marks cacheable
  // breakpoints; most third-party clients omit them. Inject them when the
  // body has none so prefix reuse happens without client cooperation.
  let cacheInjected = false;
  if (provider === 'anthropic' && (env.CACHE_BREAKPOINTS ?? '1') !== '0') {
    cacheInjected = applyAnthropicCacheBreakpoints(requestBody);
  }

  // Update request body with mapped model
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  const chatBody = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : (upstreamModel !== model || cacheInjected || usageInjected ? JSON.stringify(requestBody) : body);
  // Failover must see the original chat body so each retry re-decides bridging.
  const upstreamBody = bridgedBody !== undefined ? bridgedBody : chatBody;
  
  // Record start time
  const startTime = Date.now();
  let isError = false;
  let errorMessage = '';
  let responseStatus = 200;
  
  // Strip-retry applies to OpenAI-protocol 400s: Anthropic error bodies do not
  // name these fields, so those requests keep the single-shot path.
  const stripState = provider !== 'anthropic' && upstreamBody !== undefined
    ? createStripRetryState(upstreamBody)
    : undefined;
  // OpenAI's silent refusals are gated on request size, exactly like Go's.
  const refusalDetector = new SilentRefusalDetector(upstreamBody?.length ?? 0, provider === 'openai');
  
  try {
    // Make upstream request
    const proxyResponse = await sendWithRejectedFieldRetry((bodyText) => proxyRequest({
      url: upstreamUrl.toString(),
      method: request.method,
      headers,
      signal: request.signal,
      timeoutMs: envInt(env.UPSTREAM_HEADER_TIMEOUT_MS, 60000),
      body: new ReadableStream({
        start(controller) {
          if (bodyText !== undefined) controller.enqueue(new TextEncoder().encode(bodyText));
          controller.close();
        }
      })
    }), upstreamBody, stripState);
    
    responseStatus = proxyResponse.status;
    isError = responseStatus >= 400;
    if (isError && failover.shouldFailover({ status: responseStatus })) {
      // A 429 (or any failover status carrying Retry-After) cools the account
      // down so the very next request does not hit the same wall again.
      failover.noteRateLimit(account.id, responseStatus, proxyResponse.headers['retry-after']);
    }
    if (isError && failover.shouldFailover({ status: responseStatus }) && accounts.length > 1) {
      await proxyResponse.text().catch(() => '');
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: responseStatus, error_message: `Upstream returned ${responseStatus}`, latency_ms: Date.now() - startTime }));
      return handleFailover(chatBody, request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), groups, mappings, provider, upstreamModel, stream, model, `Upstream returned ${responseStatus}`, preferredGroupId, startTime, ctx, fallbackGroupId, stickyKey, stripState);
    }

    let finalBody: any;
    if (bridgedBody !== undefined && !isError) {
      if (stream && proxyResponse.body) {
        // The bridge stream carries the usage chunk billing reads, so first-byte
        // latency is not delayed by bookkeeping. Awaited so a first-output
        // stall is caught here and failed over like any other attempt error.
        return await streamWithRecording(responsesSseToChatStream(guardSilentRefusalStream(proxyResponse.body, refusalDetector), model), proxyResponse.status, stripBodyHeaders(proxyResponse.headers), {
          db, failover, keyRecordId: keyRecord.id,
          accountId: account.id, groupId: group.id,
          provider: provider, model: upstreamModel,
          rateMultiplier: accountRateMultiplier(account),
          startedAt: startTime,
          reasoningEffort,
          userAgent,
          ctx,
          env
        });
      }
      const buffered = await bufferResponsesSseAsChat(proxyResponse.body, model);
      finalBody = buffered.body;
      responseStatus = buffered.status;
      isError = responseStatus >= 400;
    }

    if (stream && finalBody === undefined && proxyResponse.body) {
      // Streaming records usage from the stream's completion callback so
      // first-byte latency is not delayed by bookkeeping.
      return await streamWithRecording(guardSilentRefusalStream(proxyResponse.body, refusalDetector), proxyResponse.status, proxyResponse.headers, {
        db, failover, keyRecordId: keyRecord.id,
        accountId: account.id, groupId: group.id,
        provider: provider, model: upstreamModel,
        rateMultiplier: accountRateMultiplier(account),
        startedAt: startTime,
        reasoningEffort,
        userAgent,
        ctx,
        env
      });
    }
    
    // For non-streaming responses, extract usage and record
    let responseText: string;
    let responseBody: any = {};
    if (finalBody !== undefined) {
      responseText = JSON.stringify(finalBody);
      responseBody = finalBody;
    } else {
      responseText = await proxyResponse.text();
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        // Non-JSON response
      }
    }
    
    // The estimation fallback needs the request body; a failed attempt bills nothing.
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers, isError ? undefined : requestBody);
    const breakdown = calculateCostBreakdown(provider, upstreamModel, promptTokens, completionTokens, accountRateMultiplier(account));
    const cost = breakdown.cost;
    
    // Record usage and request log
    if (cost > 0) {
      defer(ctx, db.incrementApiKeyUsage(keyRecord.id, cost));
    }
    defer(ctx, db.createUsageRecord({ api_key_id: keyRecord.id, group_id: group.id, account_id: account.id, model: upstreamModel, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, base_cost: breakdown.baseCost, rate_multiplier: breakdown.multiplier, cost_estimated: breakdown.estimated ? 1 : 0, cache_status: 'bypass', status: responseStatus, error_message: isError ? responseBody?.error?.message || 'Error' : '', latency_ms: Date.now() - startTime, reasoning_effort: reasoningEffort, user_agent: userAgent }));
    
    defer(ctx, db.createRequestLog({
      account_id: account.id,
      group_id: group.id,
      model: upstreamModel,
      status: responseStatus,
      error_message: isError ? responseBody?.error?.message || `Upstream returned ${responseStatus}` : '',
      latency_ms: Date.now() - startTime
    }));
    
    // Record for failover
    failover.recordRequest(account.id, group.id, isError);
    
    // Return response
    return new Response(responseText, {
      status: responseStatus,
      headers: {
        // The body was read (and possibly re-serialized), so the upstream's
        // framing headers describe bytes that are not being sent.
        ...stripBodyHeaders(proxyResponse.headers),
        'content-type': 'application/json', 'cache-control': 'no-store, no-transform'
      }
    });
    
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    responseStatus = 502;
    
    // Record failover
    failover.recordRequest(account.id, group.id, true);
    defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }));
    
    // Try to failover to next account
    return handleFailover(chatBody, request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), groups, mappings, provider, upstreamModel, stream, model, errorMessage, preferredGroupId, startTime, ctx, fallbackGroupId, stickyKey, stripState);
  }
}

// Handle failover to next account
async function handleFailover(
  body: string | undefined,
  request: Request,
  env: Env,
  failover: FailoverManager,
  keyRecord: any,
  accounts: Account[],
  groups: Map<number, Group>,
  mappings: ModelMapping[],
  provider: string,
  upstreamModel: string,
  stream: boolean,
  clientModel: string,
  errorMessage: string,
  preferredGroupId?: number,
  originStart: number = Date.now(),
  ctx?: Deferrable,
  fallbackGroupId = 0,
  stickyKey?: string,
  stripState?: StripRetryState
): Promise<Response> {
  const db = createDatabase(env.DB);
  const userAgent = request.headers.get('user-agent')?.slice(0, 255) || null;
  let requestMetaBody: any;
  try { requestMetaBody = body ? JSON.parse(body) : undefined; } catch { requestMetaBody = undefined; }
  const reasoningEffort = extractReasoningEffort(requestMetaBody);
  
  // Try next account (max 3 retries), with backoff inside the retry budget.
  const attempted = new Set<number>();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    // Client hangups and exhausted budgets stop the chain immediately: another
    // attempt can only burn quota nobody is left to read.
    if (request.signal?.aborted) break;
    if (retryBudgetExceeded(originStart, env)) break;
    await sleep(retryDelayMs(i + 1, env), request.signal);
    if (request.signal?.aborted) break;
    // Get next healthy account
    const nextAccounts = accounts.filter(a => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : [], { stickyKey });
    
    if (!selection) {
      break;
    }
    
    const { account, group } = selection;
    attempted.add(account.id);
    // Session hints are re-read from the body so retried OpenCode calls keep
    // the conversation id.
    let retryBody: unknown;
    try { retryBody = body ? JSON.parse(body) : undefined; } catch { retryBody = undefined; }
    
    try {
      const credentials = resolveUpstreamCredentials(account);
      const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, provider);
      const url = new URL(request.url);
      let upstreamPath = url.pathname;
      
      if (provider === 'anthropic' && !upstreamPath.includes('/v1/messages')) {
        upstreamPath = '/v1/messages';
      } else if (provider === 'xai' && !upstreamPath.includes('/chat/completions')) {
        upstreamPath = '/v1/chat/completions';
      } else if (provider === 'opencode_go' && !upstreamPath.includes('/v1/messages') && !upstreamPath.includes('/chat/completions') && !upstreamPath.includes('/responses')) {
        upstreamPath = '/v1/chat/completions';
      }

      // Re-decide the bridge per retry so an opencode_go responses-native
      // model converts again on the next account instead of replaying the
      // already-converted body.
      let retrySendBody = body;
      let retryBridged = false;
      if (provider === 'opencode_go' && body !== undefined && retryBody
          && !upstreamPath.includes('/responses') && !upstreamPath.includes('/v1/messages')
          && openCodeGoModelProtocol(String((retryBody as any)?.model || upstreamModel)) === 'responses') {
        try {
          retrySendBody = JSON.stringify(chatCompletionsToResponses(retryBody));
          upstreamPath = '/v1/responses';
          retryBridged = true;
        } catch {
          retrySendBody = body;
        }
      }
      
      const retryUrl = new URL(`${baseUrl}${upstreamPath}`);
      if (provider === 'anthropic') retryUrl.searchParams.set('beta', 'true');
      const headers = buildUpstreamHeaders(request.headers, provider, credentials.apiKey, credentials.baseUrl, account.client_spoofing);
      if (provider === 'opencode_go') {
        applyOpenCodeHeaders(headers, { clientHeaders: request.headers, body: retryBody, allowGenerate: true });
      }
      
      const sendBody = retrySendBody;
      const refusalDetector = new SilentRefusalDetector(sendBody?.length ?? 0, provider === 'openai');
      const proxyResponse = await sendWithRejectedFieldRetry((bodyText) => proxyRequest({
        url: retryUrl.toString(),
        method: request.method,
        headers,
        signal: request.signal,
        timeoutMs: envInt(env.UPSTREAM_HEADER_TIMEOUT_MS, 60000),
        body: new ReadableStream({
          start(controller) {
            if (bodyText !== undefined) controller.enqueue(new TextEncoder().encode(bodyText));
            controller.close();
          }
        })
      }), sendBody, stripState);
      
      const isError = proxyResponse.status >= 400;
      if (isError && failover.shouldFailover({ status: proxyResponse.status })) {
        failover.noteRateLimit(account.id, proxyResponse.status, proxyResponse.headers['retry-after']);
        if (i < maxRetries - 1) {
          failover.recordRequest(account.id, group.id, true);
          continue;
        }
      }

      let finalStatus = proxyResponse.status;
      let finalBody: any;
      if (retryBridged && !isError) {
        if (stream && proxyResponse.body) {
          return await streamWithRecording(responsesSseToChatStream(guardSilentRefusalStream(proxyResponse.body, refusalDetector), clientModel), proxyResponse.status, stripBodyHeaders(proxyResponse.headers), {
            db, failover, keyRecordId: keyRecord.id,
            accountId: account.id, groupId: group.id,
            provider: provider, model: upstreamModel,
            rateMultiplier: accountRateMultiplier(account),
            startedAt: originStart,
            reasoningEffort,
            userAgent,
            ctx,
            env
          });
        }
        const buffered = await bufferResponsesSseAsChat(proxyResponse.body, clientModel);
        finalBody = buffered.body;
        finalStatus = buffered.status;
      }
      const finalError = isError || finalStatus >= 400;

      // Streaming records its own request log and usage from the stream
      // completion callback, so return before the non-streaming bookkeeping.
      if (stream && !finalError && finalBody === undefined && proxyResponse.body) {
        return await streamWithRecording(guardSilentRefusalStream(proxyResponse.body, refusalDetector), proxyResponse.status, proxyResponse.headers, {
          db, failover, keyRecordId: keyRecord.id,
          accountId: account.id, groupId: group.id,
          provider: provider, model: upstreamModel,
          rateMultiplier: accountRateMultiplier(account),
          startedAt: originStart,
          reasoningEffort,
          userAgent,
          ctx,
          env
        });
      }

      failover.recordRequest(account.id, group.id, finalError);
      defer(ctx, db.createRequestLog({
        account_id: account.id,
        group_id: group.id,
        model: upstreamModel,
        status: finalStatus,
        error_message: finalError ? errorMessage || `Upstream returned ${finalStatus}` : '',
        latency_ms: 0
      }));
      const responseText = finalBody !== undefined ? JSON.stringify(finalBody) : await proxyResponse.text();

      // A successful retry served real tokens; bill it exactly as the main
      // path does, or every failed-over call vanishes from quota accounting.
      let retryResponseBody: any = {};
      try { retryResponseBody = JSON.parse(responseText); } catch { /* non-JSON */ }
      const usage = extractTokenUsage(retryResponseBody, proxyResponse.headers, finalError ? undefined : requestMetaBody);
      const retryBreakdown = calculateCostBreakdown(provider, upstreamModel, usage.promptTokens, usage.completionTokens, accountRateMultiplier(account));
      if (retryBreakdown.cost > 0) {
        defer(ctx, db.incrementApiKeyUsage(keyRecord.id, retryBreakdown.cost));
      }
      defer(ctx, db.createUsageRecord({ api_key_id: keyRecord.id, group_id: group.id, account_id: account.id, model: upstreamModel, provider, prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, cost: retryBreakdown.cost, base_cost: retryBreakdown.baseCost, rate_multiplier: retryBreakdown.multiplier, cost_estimated: retryBreakdown.estimated ? 1 : 0, cache_status: 'bypass', status: finalStatus, error_message: finalError ? retryResponseBody?.error?.message || errorMessage : '', latency_ms: Date.now() - originStart, reasoning_effort: reasoningEffort, user_agent: userAgent }));
      
      return new Response(responseText, {
        status: finalStatus,
        headers: {
          ...stripBodyHeaders(proxyResponse.headers),
          'content-type': 'application/json', 'cache-control': 'no-store, no-transform'
        }
      });
      
    } catch (retryError) {
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : 'Upstream request failed', latency_ms: 0 }));
      continue;
    }
  }
  
  // All retries failed
  return new Response(JSON.stringify({ 
    error: 'All accounts failed',
    message: errorMessage 
  }), { 
    status: 502, 
    headers: { 'Content-Type': 'application/json' } 
  });
}
