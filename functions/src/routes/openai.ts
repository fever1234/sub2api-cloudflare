// OpenAI-compatible route handler (OpenAI, Responses, Chat Completions)
import type { Env } from '../index';
import { createDatabase } from '../db';
import { authenticateApiKey } from '../auth';
import { FailoverManager } from '../failover';
import { proxyRequest, buildUpstreamHeaders, getUpstreamBaseUrl, findModelMapping, resolveUpstreamCredentials , accountRateMultiplier, stripBodyHeaders } from '../utils/proxy';
import { applyOpenCodeHeaders } from '../utils/opencode-session';
import { openCodeGoModelProtocol, chatCompletionsToResponses, responsesSseToChatStream, bufferResponsesSseAsChat } from '../utils/responses-bridge';
import { streamWithRecording } from '../utils/record';
import { defer, Deferrable } from '../utils/background';
import { getModelFromHeader } from '../utils/headers';
import { extractTokenUsage, calculateCostBreakdown } from '../billing';
import { Account, Group, ModelMapping } from '../types';
import { loadRoutingSnapshot } from '../utils/routing-cache';

export async function handleOpenAIRequest(request: Request, env: Env, failover: FailoverManager, ctx?: Deferrable): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  
  // Extract API key
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
    requestBody = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  
  const model = requestBody.model || getModelFromHeader(request) || '';
  const stream = requestBody.stream === true;
  const isResponses = url.pathname.includes('/responses');
  
  // Determine endpoint
  let endpoint = '/v1/chat/completions';
  if (isResponses) {
    endpoint = '/v1/responses';
  }
  
  // Get OpenAI-compatible accounts
  const routing = await loadRoutingSnapshot(db, failover);
  let accounts = routing.accounts;
  accounts = accounts.filter(a => (a.provider === 'openai' || a.provider === 'xai' || a.provider === 'opencode_go') && a.enabled);

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
        message: '�?API 密钥绑定的主分组和兜底分组下没有可用账号'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  // Load supporting data
  const groups = new Map(routing.groups.map(g => [g.id, g]));
  const mappings = routing.mappings;
  
  // Apply model mapping
  const mapping = findModelMapping(model, mappings, 'openai')
    || findModelMapping(model, mappings, 'xai')
    || findModelMapping(model, mappings, 'opencode_go');
  const requestedProvider = mapping?.provider || (model.toLowerCase().startsWith('grok-') ? 'xai' : undefined);
  if (requestedProvider) {
    accounts = accounts.filter(account => account.provider === requestedProvider);
  }
  if (accounts.length === 0) {
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
  const selection = await failover.selectAccount(accounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : []);
  if (!selection) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { account, group } = selection;
  const provider = account.provider;

  // opencode_go serves responses-native models (muse-spark-*, grok-*, gpt-*)
  // only on /v1/responses. Bridge the chat request so an OpenAI-compatible
  // client can still use them; every other model keeps the direct chat path.
  let bridged = false;
  let outboundBody: unknown = requestBody;
  if (!isResponses && provider === 'opencode_go' && openCodeGoModelProtocol(upstreamModel) === 'responses') {
    try {
      outboundBody = chatCompletionsToResponses(requestBody);
      endpoint = '/v1/responses';
      bridged = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request cannot be converted to the Responses API';
      return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code: null } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Build upstream request
  const credentials = resolveUpstreamCredentials(account);
  const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, provider);
  const upstreamUrl = `${baseUrl}${endpoint}`;
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
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(outboundBody)));
          controller.close();
        }
      })
    });
    
    const isError = proxyResponse.status >= 400;
    if (isError && failover.shouldFailover({ status: proxyResponse.status }) && accounts.length > 1) {
      await proxyResponse.text().catch(() => '');
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: `Upstream returned ${proxyResponse.status}`, latency_ms: Date.now() - startTime }));
      return handleFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), groups, mappings, provider, upstreamModel, stream, model, `Upstream returned ${proxyResponse.status}`, preferredGroupId, startTime, ctx, fallbackGroupId);
    }

    let finalStatus = proxyResponse.status;
    let finalBody: any;
    if (bridged && !isError) {
      if (stream && proxyResponse.body) {
        // The bridge stream carries the usage chunk billing reads, so first-byte
        // latency is not delayed by bookkeeping.
        return streamWithRecording(responsesSseToChatStream(proxyResponse.body, model), proxyResponse.status, stripBodyHeaders(proxyResponse.headers), {
          db, failover, keyRecordId: keyRecord.id,
          accountId: account.id, groupId: group.id,
          provider: provider, model: upstreamModel,
          rateMultiplier: accountRateMultiplier(account),
          startedAt: startTime,
          ctx
        });
      }
      const buffered = await bufferResponsesSseAsChat(proxyResponse.body, model);
      finalBody = buffered.body;
      finalStatus = buffered.status;
    }

    if (stream && finalBody === undefined && proxyResponse.body) {
      // Streaming records usage from the stream's completion callback so
      // first-byte latency is not delayed by bookkeeping.
      return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
        db, failover, keyRecordId: keyRecord.id,
        accountId: account.id, groupId: group.id,
        provider: provider, model: upstreamModel,
        rateMultiplier: accountRateMultiplier(account),
        startedAt: startTime,
        ctx
      });
    }
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
    const finalError = finalStatus >= 400;
    
    // Calculate cost
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const breakdown = calculateCostBreakdown(provider, upstreamModel, promptTokens, completionTokens, accountRateMultiplier(account));
    const cost = breakdown.cost;
    
    // Record usage
    if (cost > 0) {
      defer(ctx, db.incrementApiKeyUsage(keyRecord.id, cost));
    }
    defer(ctx, db.createUsageRecord({ api_key_id: keyRecord.id, group_id: group.id, account_id: account.id, model: upstreamModel, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, base_cost: breakdown.baseCost, rate_multiplier: breakdown.multiplier, cost_estimated: breakdown.estimated ? 1 : 0, cache_status: 'bypass', status: finalStatus, error_message: finalError ? responseBody?.error?.message || 'Error' : '', latency_ms: Date.now() - startTime }));
    
    // Record request log
    defer(ctx, db.createRequestLog({
      account_id: account.id,
      group_id: group.id,
      model: upstreamModel,
      status: finalStatus,
      error_message: finalError ? responseBody?.error?.message || 'Error' : '',
      latency_ms: Date.now() - startTime
    }));
    
    // Record for failover
    failover.recordRequest(account.id, group.id, finalError);
    
    return new Response(responseText, {
      status: finalStatus,
      headers: {
        // The bridge re-serialized the body, so the upstream's framing headers
        // describe bytes that are not being sent.
        ...(finalBody !== undefined ? stripBodyHeaders(proxyResponse.headers) : proxyResponse.headers),
        'content-type': 'application/json', 'cache-control': 'no-store, no-transform'
      }
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    failover.recordRequest(account.id, group.id, true);
    defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }));
    
    // Try failover
    return handleFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), groups, mappings, provider, upstreamModel, stream, model, errorMessage, preferredGroupId, startTime, ctx, fallbackGroupId);
  }
}

// Failover handler
async function handleFailover(
  body: string,
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
  fallbackGroupId = 0
): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  const isResponses = url.pathname.includes('/responses');
  let endpoint = '/v1/chat/completions';
  if (isResponses) endpoint = '/v1/responses';
  
  const attempted = new Set<number>();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter(a => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, groups, preferredGroupId, fallbackGroupId ? [fallbackGroupId] : []);
    
    if (!selection) break;
    
    const { account, group } = selection;
    attempted.add(account.id);
    const currentProvider = account.provider;
    // Session hints are read from the body on the retry path too, so a retried
    // OpenCode call keeps the conversation id rather than minting a new one.
    let retryBody: any;
    try { retryBody = JSON.parse(body); } catch { retryBody = undefined; }
    
    try {
      const credentials = resolveUpstreamCredentials(account);
      const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, currentProvider);
      // Re-decide the bridge per retry: the next account may be a different
      // provider, and only opencode_go responses-native models convert.
      let retryEndpoint = endpoint;
      let retrySendBody = body;
      let retryBridged = false;
      if (!isResponses && currentProvider === 'opencode_go' && retryBody && openCodeGoModelProtocol(String(retryBody.model || upstreamModel)) === 'responses') {
        try {
          retrySendBody = JSON.stringify(chatCompletionsToResponses(retryBody));
          retryEndpoint = '/v1/responses';
          retryBridged = true;
        } catch {
          retrySendBody = body;
          retryEndpoint = endpoint;
        }
      }
      const upstreamUrl = `${baseUrl}${retryEndpoint}`;
      const headers = buildUpstreamHeaders(request.headers, currentProvider, credentials.apiKey, credentials.baseUrl, account.client_spoofing);
      if (currentProvider === 'opencode_go') {
        applyOpenCodeHeaders(headers, { clientHeaders: request.headers, body: retryBody, allowGenerate: true });
      }
      const sendBody = retrySendBody;
      const proxyResponse = await proxyRequest({
        url: upstreamUrl,
        method: request.method,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sendBody));
            controller.close();
          }
        })
      });
      
      const isError = proxyResponse.status >= 400;
      if (isError && failover.shouldFailover({ status: proxyResponse.status }) && i < maxRetries - 1) {
        failover.recordRequest(account.id, group.id, true);
        continue;
      }
      
      let finalStatus = proxyResponse.status;
      let finalBody: any;
      if (retryBridged && !isError) {
        if (stream && proxyResponse.body) {
          return streamWithRecording(responsesSseToChatStream(proxyResponse.body, clientModel), proxyResponse.status, stripBodyHeaders(proxyResponse.headers), {
            db, failover, keyRecordId: keyRecord.id,
            accountId: account.id, groupId: group.id,
            provider: currentProvider, model: upstreamModel,
            rateMultiplier: accountRateMultiplier(account),
            startedAt: originStart,
            ctx
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
        return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
          db, failover, keyRecordId: keyRecord.id,
          accountId: account.id, groupId: group.id,
          provider: currentProvider, model: upstreamModel,
          rateMultiplier: accountRateMultiplier(account),
          startedAt: originStart,
          ctx
        });
      }

      failover.recordRequest(account.id, group.id, finalError);
      defer(ctx, db.createRequestLog({
        account_id: account.id,
        group_id: group.id,
        model: upstreamModel,
        status: finalStatus,
        error_message: finalError ? errorMessage : '',
        latency_ms: 0
      }));
      const responseText = finalBody !== undefined ? JSON.stringify(finalBody) : await proxyResponse.text();
      
      return new Response(responseText, {
        status: finalStatus,
        headers: {
          ...(finalBody !== undefined ? stripBodyHeaders(proxyResponse.headers) : proxyResponse.headers),
          'content-type': 'application/json', 'cache-control': 'no-store, no-transform'
        }
      });
      
    } catch (retryError) {
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : 'Upstream request failed', latency_ms: 0 }));
      continue;
    }
  }
  
  return new Response(JSON.stringify({ error: 'All accounts failed', message: errorMessage }), { status: 502, headers: { 'Content-Type': 'application/json' } });
}
