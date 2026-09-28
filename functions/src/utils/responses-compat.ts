// OpenAI Responses 400 field-strip retry — ported from
// backend/internal/service/openai_responses_rejected_field_retry.go.
//
// Relays and third-party upstreams reject otherwise-valid Responses bodies for
// fields their schema does not model (max_output_tokens, truncation, replayed
// input[i].namespace/status, prompt_cache_breakpoint on non-cache models…).
// The upstream names the offending field in the 400 body; dropping exactly
// that field and re-sending once succeeds where a hard 400 would fail the
// client. The retry is bounded by a shared per-request budget and a body-hash
// dedupe so a pathological upstream cannot loop.

import type { ProxyResponse } from '../types';

const MAX_STRIP_RETRIES = 6;

export interface StripRetryState {
  seen: Set<string>;
  attempts: number;
}

export function createStripRetryState(initialBody?: string): StripRetryState {
  const seen = new Set<string>();
  if (initialBody) seen.add(initialBody);
  return { seen, attempts: 0 };
}

function allowStripRetry(state: StripRetryState, nextBody: string): boolean {
  if (!nextBody || state.seen.has(nextBody) || state.attempts >= MAX_STRIP_RETRIES) return false;
  state.seen.add(nextBody);
  state.attempts += 1;
  return true;
}

const RE_NAMESPACE_PARAM = /^input\[(\d+)\]\.namespace$/i;
const RE_STATUS_PARAM = /^input\[(\d+)\]\.status$/i;
const RE_CONTENT_PARAM = /^input\[(\d+)\]\.content$/i;
const RE_CACHE_PARAM = /^input\[(\d+)\]\.prompt_cache_breakpoint$/i;
const RE_REJECTED_MESSAGE_PARAM = /(?:unknown|unsupported)[ _-]+parameter\s*(?::|=|is)?\s*["']?(max_output_tokens|truncation|input\[\d+\]\.(?:namespace|status))(?:["']|\b)/i;
const RE_INVALID_TYPE_CONTENT = /invalid[ _-]+type\s+for\s+["']?(input\[\d+\]\.content)(?:["']|\b)[^\n]*\b(?:got|received)\s+null\b/i;
const RE_MAX_ZERO_CONTENT = /invalid\s+["']?(input\[\d+\]\.content)["']?\s*:\s*array too long\.[^\n]*maximum length 0\b/i;
const RE_CACHE_MODEL_REJECTION = /["']?(prompt_cache_breakpoint|input\[\d+\]\.prompt_cache_breakpoint)["']?\s+is\s+not\s+supported\s+on\s+this\s+model\b/i;
const RE_TOOL_PARAMETERS_PARAM = /^(?:tools|input)\[\d+\](?:\.tools\[\d+\])*(?:\.function)?\.parameters$/i;
const RE_MISSING_SCHEMA_TYPE = /\bgot\s+["']?type\s*:\s*["']?none["']?/i;

const TOOL_CALL_ITEM_TYPES = ['function_call', 'tool_call', 'custom_tool_call', 'mcp_tool_call'];

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function readInputItem(body: any, index: number): Record<string, any> | undefined {
  if (!Array.isArray(body?.input)) return undefined;
  return asRecord(body.input[index]);
}

function extractErrorFields(errorBodyText: string): { code: string; message: string; param: string } {
  let parsed: any;
  try { parsed = JSON.parse(errorBodyText); } catch { return { code: '', message: '', param: '' }; }
  const root = asRecord(parsed);
  const error = asRecord(root?.error);
  let message = String(error?.message ?? root?.detail ?? root?.message ?? '').trim();
  let code = String(error?.code ?? '').trim();
  const param = String(error?.param ?? '').trim();
  // Some relays wrap the real error as a JSON string inside error.message.
  if (message.startsWith('{')) {
    try {
      const inner = asRecord(JSON.parse(message));
      const innerError = asRecord(inner?.error);
      if (innerError?.code && !code) code = String(innerError.code).trim();
      const innerMessage = String(innerError?.message ?? '').trim();
      if (innerMessage) message = innerMessage;
    } catch { /* keep the outer message */ }
  }
  return { code, message, param };
}

// A function tool's parameter root must be a concrete object schema. Upstreams
// that report "got type: none" reject a root whose type is null/missing; an
// object-only anyOf/oneOf implies object unambiguously. Only the root is
// repaired — nested property schemas keep the client's shape.
function repairToolParameterRootTypes(body: any): boolean {
  const candidates: Record<string, any>[] = [];
  const collectTools = (tools: unknown) => {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      const record = asRecord(tool);
      if (!record) continue;
      const direct = asRecord(record.parameters);
      if (direct) candidates.push(direct);
      const nested = asRecord(asRecord(record.function)?.parameters);
      if (nested) candidates.push(nested);
    }
  };
  collectTools(body?.tools);
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      const record = asRecord(item);
      if (!record) continue;
      const direct = asRecord(record.parameters);
      if (direct) candidates.push(direct);
      collectTools(record.tools);
    }
  }
  let changed = false;
  for (const params of candidates) {
    const hasType = Object.prototype.hasOwnProperty.call(params, 'type');
    if (!hasType || params.type === null) {
      if (hasType) {
        params.type = 'object';
        changed = true;
      } else {
        const union = Array.isArray(params.anyOf) ? params.anyOf : (Array.isArray(params.oneOf) ? params.oneOf : undefined);
        const objectOnly = !!union && union.length > 0 && union.every(member => {
          const record = asRecord(member);
          return !!record && (record.type === undefined || record.type === null || record.type === 'object');
        });
        if (objectOnly) {
          params.type = 'object';
          changed = true;
        }
      }
    }
    if ('required' in params && params.required === null) {
      delete params.required;
      changed = true;
    }
  }
  return changed;
}

interface StripOutcome { body: string; reason: string }

// Returns the rewritten request body when the upstream 400 names a field this
// gateway can drop, or null when the error is not a recognized rejection.
export function stripRejectedResponseFields(errorBodyText: string, sentBody: string): StripOutcome | null {
  if (!errorBodyText || !sentBody) return null;
  const { code, message, param } = extractErrorFields(errorBodyText);
  const lcCode = code.toLowerCase();
  const lcMessage = message.toLowerCase();
  let lcParam = param.toLowerCase();
  if (!lcCode && !lcMessage && !lcParam) return null;

  let body: any;
  try { body = JSON.parse(sentBody); } catch { return null; }
  if (!asRecord(body)) return null;
  const rewrite = (reason: string): StripOutcome => ({ body: JSON.stringify(body), reason });

  // Tool parameter root type rejection: repair instead of strip.
  if (lcCode === 'invalid_function_parameters' && RE_TOOL_PARAMETERS_PARAM.test(lcParam) && RE_MISSING_SCHEMA_TYPE.test(lcMessage)) {
    if (repairToolParameterRootTypes(body)) return rewrite('tool parameter root type rejection');
  }

  // Cache-breakpoint rejection on a non-cache model: the model simply has no
  // breakpoint support, so the field must go (top-level or on an input item).
  const messageCacheParam = (RE_CACHE_MODEL_REJECTION.exec(lcMessage)?.[1] || '').toLowerCase();
  const cacheParam = lcParam || messageCacheParam;
  const cacheParamMatchesMessage = !messageCacheParam || cacheParam === messageCacheParam;
  const cacheModelRejection = lcCode === 'invalid_parameter' || !!messageCacheParam;
  if (cacheParam && cacheParamMatchesMessage && cacheModelRejection) {
    if (cacheParam === 'prompt_cache_breakpoint' && Object.prototype.hasOwnProperty.call(body, 'prompt_cache_breakpoint')) {
      delete body.prompt_cache_breakpoint;
      return rewrite('prompt_cache_breakpoint parameter rejection');
    }
    const cacheIndexMatch = RE_CACHE_PARAM.exec(cacheParam);
    if (cacheIndexMatch) {
      const item = readInputItem(body, Number(cacheIndexMatch[1]));
      if (item && Object.prototype.hasOwnProperty.call(item, 'prompt_cache_breakpoint')) {
        delete item.prompt_cache_breakpoint;
        return rewrite('indexed prompt_cache_breakpoint parameter rejection');
      }
      return null;
    }
  }

  // Explicit unknown/unsupported parameter rejection.
  const explicitRejection = lcCode === 'unknown_parameter' || lcCode === 'unsupported_parameter'
    || lcMessage.includes('unknown parameter') || lcMessage.includes('unsupported parameter');
  if (explicitRejection) {
    const messageParam = (RE_REJECTED_MESSAGE_PARAM.exec(lcMessage)?.[1] || '').toLowerCase();
    if (lcParam && messageParam && lcParam !== messageParam) return null;
    if (!lcParam) lcParam = messageParam;
    if (lcParam) {
      const namespaceMatch = RE_NAMESPACE_PARAM.exec(lcParam);
      if (namespaceMatch) {
        const item = readInputItem(body, Number(namespaceMatch[1]));
        if (!item) return null;
        const itemType = String(item.type ?? '').toLowerCase().trim();
        if (!TOOL_CALL_ITEM_TYPES.includes(itemType) || !Object.prototype.hasOwnProperty.call(item, 'namespace')) return null;
        delete item.namespace;
        return rewrite('indexed namespace parameter rejection');
      }
      const statusMatch = RE_STATUS_PARAM.exec(lcParam);
      if (statusMatch) {
        // The upstream names one index, but every item of the rejected type
        // carries the same unmodeled field: clearing one per round trip would
        // exhaust the retry budget on a replayed conversation.
        const index = Number(statusMatch[1]);
        const rejectedItem = readInputItem(body, index);
        if (!rejectedItem || !Object.prototype.hasOwnProperty.call(rejectedItem, 'status')) return null;
        const rejectedType = String(rejectedItem.type ?? '').trim();
        let cleared = 0;
        if (Array.isArray(body.input) && rejectedType) {
          for (const candidate of body.input) {
            const record = asRecord(candidate);
            if (!record || String(record.type ?? '').trim() !== rejectedType) continue;
            if (!Object.prototype.hasOwnProperty.call(record, 'status')) continue;
            delete record.status;
            cleared += 1;
          }
        }
        if (cleared === 0) delete rejectedItem.status;
        return rewrite('indexed status parameter rejection');
      }
      if (lcParam === 'max_output_tokens' && Object.prototype.hasOwnProperty.call(body, 'max_output_tokens')) {
        delete body.max_output_tokens;
        return rewrite('max_output_tokens parameter rejection');
      }
      if (lcParam === 'truncation' && Object.prototype.hasOwnProperty.call(body, 'truncation')) {
        delete body.truncation;
        return rewrite('truncation parameter rejection');
      }
    }
  }

  // Null content on an input item: reasoning items drop the field, message
  // items normalize it to an empty string.
  const messageContentParam = (RE_INVALID_TYPE_CONTENT.exec(lcMessage)?.[1] || '').toLowerCase();
  const contentParam = lcParam || messageContentParam;
  const contentMatch = RE_CONTENT_PARAM.exec(contentParam);
  const explicitNullContent = (lcCode === 'invalid_type' || lcCode === 'invalid_request_error' || lcCode === '')
    && RE_INVALID_TYPE_CONTENT.test(lcMessage);
  if (contentMatch && contentParam === messageContentParam && explicitNullContent) {
    const item = readInputItem(body, Number(contentMatch[1]));
    if (!item || !Object.prototype.hasOwnProperty.call(item, 'content') || item.content !== null) return null;
    const itemType = String(item.type ?? '').toLowerCase().trim();
    const role = String(item.role ?? '').trim();
    if (itemType === 'reasoning') {
      delete item.content;
      return rewrite('indexed reasoning null content rejection');
    }
    if (itemType === 'message' || role) {
      item.content = '';
      return rewrite('indexed message null content rejection');
    }
    return null;
  }

  // Reasoning item over the upstream content limit: the item's history is
  // replay-only, so dropping it keeps the request under the cap.
  const maxZeroParam = (RE_MAX_ZERO_CONTENT.exec(lcMessage)?.[1] || '').toLowerCase();
  const maxZeroMatch = RE_CONTENT_PARAM.exec(lcParam);
  if (maxZeroMatch && lcParam === maxZeroParam && lcCode === 'array_above_max_length') {
    const item = readInputItem(body, Number(maxZeroMatch[1]));
    if (!item || String(item.type ?? '').toLowerCase().trim() !== 'reasoning') return null;
    if (!Array.isArray(item.content) || item.content.length === 0) return null;
    delete item.content;
    return rewrite('indexed reasoning content maximum-length rejection');
  }

  return null;
}

// Sends `initialBody`, and on a 400 whose error names a strippable field
// rewrites and re-sends — bounded by the shared per-request budget. The final
// response always has a readable body: a consumed 400 is rebuilt from the text
// that was read.
export async function sendWithRejectedFieldRetry(
  send: (bodyText: string | undefined) => Promise<ProxyResponse>,
  initialBody: string | undefined,
  state?: StripRetryState
): Promise<ProxyResponse> {
  if (!state || initialBody === undefined) return send(initialBody);
  let bodyText = initialBody;
  for (;;) {
    const response = await send(bodyText);
    if (response.status !== 400) return response;
    const errorText = await response.text().catch(() => '');
    const stripped = stripRejectedResponseFields(errorText, bodyText);
    if (!stripped || !allowStripRetry(state, stripped.body)) {
      const headers = { ...response.headers };
      delete headers['content-encoding'];
      delete headers['Content-Encoding'];
      delete headers['content-length'];
      delete headers['Content-Length'];
      return {
        status: 400,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(errorText));
            controller.close();
          }
        }),
        text: async () => errorText
      };
    }
    bodyText = stripped.body;
  }
}
