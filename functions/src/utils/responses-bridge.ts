// Chat Completions ⇄ OpenAI Responses bridge for opencode_go.
//
// OpenCode Go serves one native endpoint per model family: glm/kimi/deepseek/
// mimo/longcat/hy speak Chat Completions, minimax/qwen speak Anthropic
// Messages, and grok-*/gpt-*/muse-spark-* speak only the Responses API. A
// client that sends /v1/chat/completions with a responses-native model would
// otherwise 404 at the upstream, so this module converts the request, the
// buffered response and the SSE stream between the two shapes.
//
// Ported from Wei-Shaw/sub2api:
//   backend/internal/pkg/apicompat/chatcompletions_to_responses.go
//   backend/internal/pkg/apicompat/responses_to_chatcompletions.go
//   backend/internal/pkg/apicompat/response_format.go
//   backend/internal/service/opencode_go.go (protocol rule table)

export type OpenCodeProtocol = 'chat_completions' | 'responses' | 'anthropic';

interface ProtocolRule {
  pattern: string;
  protocol: OpenCodeProtocol;
}

// First match wins; anything unmatched falls back to Chat Completions, so a
// model OpenCode adds later keeps working without a code change as long as it
// speaks chat completions. New responses-native families get a rule here.
const OPENCODE_GO_PROTOCOL_RULES: ProtocolRule[] = [
  { pattern: 'grok-*', protocol: 'responses' },
  { pattern: 'gpt-*', protocol: 'responses' },
  { pattern: 'muse-spark-*', protocol: 'responses' },
  { pattern: 'minimax-*', protocol: 'anthropic' },
  { pattern: 'qwen*', protocol: 'anthropic' },
];

/** Strip the client-facing opencode/ prefix so pattern rules see the catalog id. */
export function normalizeOpenCodeModelId(model: string): string {
  let value = String(model || '').toLowerCase().trim();
  for (const prefix of ['opencode-go/', 'opencode_go/', 'opencode/']) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length);
  }
  return value;
}

function protocolRuleMatches(pattern: string, model: string): boolean {
  const rule = String(pattern || '').toLowerCase().trim();
  if (!rule || !model) return false;
  if (rule === '*') return true;
  if (rule.endsWith('*')) return model.startsWith(rule.slice(0, -1));
  return rule === model;
}

/**
 * The native upstream endpoint family for one model. `responses` means the
 * caller must bridge a Chat Completions request onto /v1/responses.
 */
export function openCodeGoModelProtocol(model: string): OpenCodeProtocol {
  const normalized = normalizeOpenCodeModelId(model);
  for (const rule of OPENCODE_GO_PROTOCOL_RULES) {
    if (rule.protocol !== 'chat_completions' && rule.protocol !== 'anthropic' && rule.protocol !== 'responses') continue;
    if (protocolRuleMatches(rule.pattern, normalized)) return rule.protocol;
  }
  return 'chat_completions';
}

// ---------------------------------------------------------------------------
// Chat Completions → Responses request
// ---------------------------------------------------------------------------

const MIN_MAX_OUTPUT_TOKENS = 128;

/** Reasoning-only models reject temperature/top_p on the Responses API. */
function isReasoningModel(model: string): boolean {
  return /^gpt-5/.test(model) || /^gpt-6-(sol|luna)/.test(model);
}

function isGpt6SolOrLuna(model: string): boolean {
  return /^gpt-6-(sol|luna)/.test(model);
}

function asNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Chat `response_format` → Responses `text.format` (unwrap json_schema). */
function chatResponseFormatToResponsesTextFormat(format: unknown): unknown {
  if (!isObject(format)) return undefined;
  if (format.type !== 'json_schema') return format;
  const inner = format.json_schema;
  if (!isObject(inner)) return format;
  return { ...inner, type: 'json_schema' };
}

function isEmptyBase64DataUri(raw: string): boolean {
  if (!raw.startsWith('data:')) return false;
  const rest = raw.slice('data:'.length);
  const semicolon = rest.indexOf(';');
  if (semicolon < 0) return false;
  const tail = rest.slice(semicolon + 1);
  if (!tail.startsWith('base64,')) return false;
  return tail.slice('base64,'.length).trim() === '';
}

/** Flatten chat content (string or parts) to plain text. */
function chatContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (isObject(part) && part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
      texts.push(part.text);
    }
  }
  return texts.join('');
}

/** Chat multimodal parts → Responses content parts. */
function chatPartsToResponsesParts(parts: any[]): any[] {
  const out: any[] = [];
  for (const part of parts) {
    if (!isObject(part)) continue;
    const breakpoint = part.prompt_cache_breakpoint;
    if (part.type === 'text') {
      const text = String(part.text ?? '');
      if (text !== '' || breakpoint !== undefined) {
        out.push({ ...(breakpoint !== undefined ? { prompt_cache_breakpoint: breakpoint } : {}), type: 'input_text', text });
      }
    } else if (part.type === 'image_url') {
      const url = isObject(part.image_url) ? String(part.image_url.url || '') : '';
      if (url && !isEmptyBase64DataUri(url)) {
        out.push({ ...(breakpoint !== undefined ? { prompt_cache_breakpoint: breakpoint } : {}), type: 'input_image', image_url: url });
      }
    } else if (part.type === 'file') {
      const file = part.file;
      if (isObject(file) && (file.file_data || file.file_id)) {
        out.push({
          ...(breakpoint !== undefined ? { prompt_cache_breakpoint: breakpoint } : {}),
          type: 'input_file',
          ...(file.filename ? { filename: file.filename } : {}),
          ...(file.file_data ? { file_data: file.file_data } : {}),
          ...(file.file_id ? { file_id: file.file_id } : {})
        });
      }
    }
  }
  return out;
}

/** String content stays a string; parts arrays convert (or collapse to ""). */
function chatMessageContentToResponsesContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = chatPartsToResponsesParts(content);
    if (parts.length === 0) return '';
    return parts;
  }
  return '';
}

/** Assistant content as text, wrapping structured thinking parts in tags. */
function parseAssistantContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (!isObject(part)) continue;
    const text = typeof part.text === 'string' ? part.text : '';
    if (part.type === 'thinking' || part.type === 'reasoning') {
      const thinking = typeof part.thinking === 'string' && part.thinking !== '' ? part.thinking : text;
      if (thinking) out += `<thinking>${thinking}</thinking>`;
    } else if (text) {
      out += text;
    }
  }
  return out;
}

function chatMessageToInputItems(message: any): any[] {
  const role = String(message?.role || 'user');
  switch (role) {
    case 'system':
    case 'user':
    case 'developer':
      return [{ role: role === 'developer' ? 'system' : role, content: chatMessageContentToResponsesContent(message.content) }];
    case 'assistant': {
      const items: any[] = [];
      let content = '';
      if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
        content = `<thinking>${message.reasoning_content}</thinking>`;
      }
      const text = parseAssistantContent(message.content);
      if (text !== '') {
        content = content ? `${content}\n${text}` : text;
      }
      if (content !== '') {
        items.push({ role: 'assistant', content: [{ type: 'output_text', text: content }] });
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!isObject(call) || !isObject(call.function)) continue;
        const args = String(call.function.arguments ?? '');
        items.push({
          type: 'function_call',
          call_id: String(call.id ?? ''),
          name: String(call.function.name ?? ''),
          arguments: args === '' ? '{}' : args
        });
      }
      return items;
    }
    case 'tool': {
      const output = chatContentToText(message.content) || '(empty)';
      return [{ type: 'function_call_output', call_id: String(message.tool_call_id ?? ''), output }];
    }
    case 'function': {
      const output = chatContentToText(message.content) || '(empty)';
      return [{ type: 'function_call_output', call_id: String(message.name ?? ''), output }];
    }
    default:
      return [{ role: 'user', content: chatMessageContentToResponsesContent(message.content) }];
  }
}

function chatToolsToResponsesTools(tools: any[], functions: any[]): any[] {
  const out: any[] = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isObject(tool)) continue;
    const type = String(tool.type || '').toLowerCase().trim();
    if (type === 'x_search') {
      out.push({
        type: 'x_search',
        ...(tool.allowed_x_handles ? { allowed_x_handles: tool.allowed_x_handles } : {}),
        ...(tool.excluded_x_handles ? { excluded_x_handles: tool.excluded_x_handles } : {}),
        ...(tool.from_date ? { from_date: tool.from_date } : {}),
        ...(tool.to_date ? { to_date: tool.to_date } : {}),
        ...(tool.enable_image_understanding !== undefined ? { enable_image_understanding: tool.enable_image_understanding } : {}),
        ...(tool.enable_video_understanding !== undefined ? { enable_video_understanding: tool.enable_video_understanding } : {})
      });
      continue;
    }
    if (type === 'web_search' || type === 'code_execution') {
      out.push({ type });
      continue;
    }
    if (type !== 'function' || !isObject(tool.function)) continue;
    out.push({
      type: 'function',
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
      strict: tool.function.strict === undefined ? false : tool.function.strict
    });
  }
  for (const fn of Array.isArray(functions) ? functions : []) {
    if (!isObject(fn)) continue;
    out.push({
      type: 'function',
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      strict: fn.strict === undefined ? false : fn.strict
    });
  }
  return out;
}

/** Legacy chat `function_call` ({"name":"X"}) → Responses tool_choice. */
function chatFunctionCallToToolChoice(raw: unknown): unknown {
  if (typeof raw === 'string') return raw;
  if (isObject(raw)) return { type: 'function', name: raw.name };
  return undefined;
}

/**
 * Chat's forced-tool spelling nests the name — `{"type":"function",
 * "function":{"name":"x"}}` — which the Responses API rejects; it wants the
 * flat `{"type":"function","name":"x"}`. Strings ("auto"/"required"/"none")
 * and already-flat objects pass through untouched. The Go port forwards the
 * nested form verbatim, so this deliberately deviates: an agent that pins a
 * tool would otherwise 400 on every call.
 */
function chatToolChoiceToResponses(choice: unknown): unknown {
  if (!isObject(choice)) return choice;
  if (choice.type === 'function' && isObject(choice.function)
      && typeof choice.function.name === 'string' && choice.name === undefined) {
    return { type: 'function', name: choice.function.name };
  }
  return choice;
}

/**
 * Convert a Chat Completions request body into a Responses API request body.
 * `stream` is forced to true: the upstream always streams, and a non-streaming
 * client is served by buffering the SSE (see bufferResponsesSseAsChat).
 */
export function chatCompletionsToResponses(chat: any): any {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const input = messages.flatMap((message: any) => chatMessageToInputItems(message));

  const out: Record<string, any> = {
    model: chat.model,
    input,
    stream: true,
    include: ['reasoning.encrypted_content'],
    store: false
  };

  if (typeof chat.instructions === 'string' && chat.instructions !== '') out.instructions = chat.instructions;

  // gpt-5.x (and gpt-6 sol/luna unless effort is "none") reject sampling params.
  const dropSampling = isReasoningModel(String(chat.model || ''))
    && !(isGpt6SolOrLuna(String(chat.model || '')) && chat.reasoning_effort === 'none');
  if (!dropSampling) {
    if (chat.temperature !== undefined && chat.temperature !== null) out.temperature = chat.temperature;
    if (chat.top_p !== undefined && chat.top_p !== null) out.top_p = chat.top_p;
  }

  const maxTokens = asNumber(chat.max_completion_tokens) ?? asNumber(chat.max_tokens);
  if (maxTokens !== undefined && maxTokens > 0) {
    out.max_output_tokens = Math.max(maxTokens, MIN_MAX_OUTPUT_TOKENS);
  }

  if (typeof chat.reasoning_effort === 'string' && chat.reasoning_effort !== '') {
    out.reasoning = { effort: chat.reasoning_effort, summary: 'auto' };
  }

  const format = chatResponseFormatToResponsesTextFormat(chat.response_format);
  if (format !== undefined) out.text = { format };

  const tools = chatToolsToResponsesTools(chat.tools, chat.functions);
  if (tools.length > 0) out.tools = tools;

  if (chat.tool_choice !== undefined && chat.tool_choice !== null && chat.tool_choice !== '') {
    out.tool_choice = chatToolChoiceToResponses(chat.tool_choice);
  } else if (chat.function_call !== undefined && chat.function_call !== null) {
    const toolChoice = chatFunctionCallToToolChoice(chat.function_call);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
  }

  if (chat.parallel_tool_calls !== undefined) out.parallel_tool_calls = chat.parallel_tool_calls;
  if (typeof chat.service_tier === 'string' && chat.service_tier !== '') out.service_tier = chat.service_tier;
  if (chat.prompt_cache_options !== undefined) out.prompt_cache_options = chat.prompt_cache_options;
  // Session resolution and upstream prompt caching both key off this field, so
  // unlike the Go port it survives the conversion.
  if (typeof chat.prompt_cache_key === 'string' && chat.prompt_cache_key !== '') out.prompt_cache_key = chat.prompt_cache_key;
  if (typeof chat.user === 'string' && chat.user !== '') out.user = chat.user;
  if (chat.stop !== undefined && chat.stop !== null) out.stop = chat.stop;

  return out;
}

// ---------------------------------------------------------------------------
// Responses response → Chat Completions response (non-streaming)
// ---------------------------------------------------------------------------

function generateChatCmplId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `chatcmpl-${hex}`;
}

function responsesStatusToChatFinishReason(status: string | undefined, incomplete: any, toolCallCount: number): string {
  if (status === 'incomplete') {
    const reason = incomplete?.reason;
    if (reason === 'max_output_tokens') return 'length';
    if (reason === 'content_filter') return 'content_filter';
    return 'stop';
  }
  if (status === 'completed' && toolCallCount > 0) return 'tool_calls';
  return 'stop';
}

interface ChatTokenDetails {
  cached_tokens?: number;
  audio_tokens?: number;
  cache_creation_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  accepted_prediction_tokens?: number;
  rejected_prediction_tokens?: number;
}

function responsesUsageToChatUsage(usage: any): any | undefined {
  if (!isObject(usage)) return undefined;
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const chat: any = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion
  };

  const inputDetails = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  if (inputDetails) {
    const details: ChatTokenDetails = {};
    if (inputDetails.cached_tokens) details.cached_tokens = inputDetails.cached_tokens;
    if (inputDetails.audio_tokens) details.audio_tokens = inputDetails.audio_tokens;
    if (inputDetails.cache_creation_tokens) details.cache_creation_tokens = inputDetails.cache_creation_tokens;
    if (inputDetails.cache_write_tokens) details.cache_write_tokens = inputDetails.cache_write_tokens;
    if (Object.keys(details).length > 0) chat.prompt_tokens_details = details;
  }
  if (Number(usage.cache_creation_input_tokens) > 0 && !chat.prompt_tokens_details?.cache_creation_tokens && !chat.prompt_tokens_details?.cache_write_tokens) {
    chat.prompt_tokens_details = { ...(chat.prompt_tokens_details || {}), cache_creation_tokens: usage.cache_creation_input_tokens };
  }

  const outputDetails = isObject(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  if (outputDetails) {
    const details: ChatTokenDetails = {};
    if (outputDetails.reasoning_tokens) details.reasoning_tokens = outputDetails.reasoning_tokens;
    if (outputDetails.audio_tokens) details.audio_tokens = outputDetails.audio_tokens;
    if (outputDetails.accepted_prediction_tokens) details.accepted_prediction_tokens = outputDetails.accepted_prediction_tokens;
    if (outputDetails.rejected_prediction_tokens) details.rejected_prediction_tokens = outputDetails.rejected_prediction_tokens;
    if (Object.keys(details).length > 0) chat.completion_tokens_details = details;
  }

  return chat;
}

/** ResponsesResponse → ChatCompletionsResponse (text, tool calls, usage). */
export function responsesToChatCompletion(response: any, model: string): any {
  const resp = isObject(response) ? response : {};
  const out: any = {
    id: resp.id || generateChatCmplId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model
  };
  if (resp.service_tier) out.service_tier = resp.service_tier;

  let contentText = '';
  let reasoningText = '';
  const toolCalls: any[] = [];

  for (const item of Array.isArray(resp.output) ? resp.output : []) {
    if (!isObject(item)) continue;
    if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (isObject(part) && part.type === 'output_text' && part.text) contentText += part.text;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '' }
      });
    } else if (item.type === 'reasoning') {
      for (const summary of Array.isArray(item.summary) ? item.summary : []) {
        if (isObject(summary) && summary.type === 'summary_text' && summary.text) reasoningText += summary.text;
      }
    }
  }

  const message: any = { role: 'assistant' };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (contentText !== '') message.content = contentText;
  if (reasoningText !== '') message.reasoning_content = reasoningText;
  if (message.content === undefined && toolCalls.length === 0) message.content = '';

  out.choices = [{
    index: 0,
    message,
    finish_reason: responsesStatusToChatFinishReason(resp.status, resp.incomplete_details, toolCalls.length)
  }];

  const usage = responsesUsageToChatUsage(resp.usage);
  if (usage) out.usage = usage;

  return out;
}

// ---------------------------------------------------------------------------
// Streaming: Responses SSE events → Chat Completions chunks (stateful)
// ---------------------------------------------------------------------------

export interface ResponsesToChatState {
  id: string;
  model: string;
  created: number;
  serviceTier: string;
  sentRole: boolean;
  sawToolCall: boolean;
  sawText: boolean;
  finalized: boolean;
  nextToolCallIndex: number;
  outputIndexToToolIndex: Record<number, number>;
  outputIndexToArguments: Record<number, string>;
  includeUsage: boolean;
  usage: any | null;
}

export function newResponsesToChatState(model: string): ResponsesToChatState {
  return {
    id: generateChatCmplId(),
    model,
    created: Math.floor(Date.now() / 1000),
    serviceTier: '',
    sentRole: false,
    sawToolCall: false,
    sawText: false,
    finalized: false,
    nextToolCallIndex: 0,
    outputIndexToToolIndex: {},
    outputIndexToArguments: {},
    includeUsage: true,
    usage: null
  };
}

function makeChatDeltaChunk(state: ResponsesToChatState, delta: any): any {
  const chunk: any = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: null }]
  };
  if (state.serviceTier) chunk.service_tier = state.serviceTier;
  return chunk;
}

function makeChatFinishChunk(state: ResponsesToChatState, finishReason: string): any {
  const chunk: any = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: { content: '' }, finish_reason: finishReason }]
  };
  if (state.serviceTier) chunk.service_tier = state.serviceTier;
  return chunk;
}

function makeChatUsageChunk(state: ResponsesToChatState): any {
  const chunk: any = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [],
    usage: state.usage
  };
  if (state.serviceTier) chunk.service_tier = state.serviceTier;
  return chunk;
}

function handleCreated(evt: any, state: ResponsesToChatState): any[] {
  const response = isObject(evt.response) ? evt.response : undefined;
  if (response) {
    if (response.id) state.id = response.id;
    if (!state.model && response.model) state.model = response.model;
    if (response.service_tier) state.serviceTier = response.service_tier;
  }
  if (state.sentRole) return [];
  state.sentRole = true;
  return [makeChatDeltaChunk(state, { role: 'assistant' })];
}

function handleTextDelta(evt: any, state: ResponsesToChatState): any[] {
  if (!evt.delta) return [];
  state.sawText = true;
  return [makeChatDeltaChunk(state, { content: evt.delta })];
}

function handleOutputItemAdded(evt: any, state: ResponsesToChatState): any[] {
  const item = isObject(evt.item) ? evt.item : undefined;
  if (!item || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) return [];

  state.sawToolCall = true;
  const index = state.nextToolCallIndex;
  state.outputIndexToToolIndex[Number(evt.output_index)] = index;
  state.nextToolCallIndex += 1;

  return [makeChatDeltaChunk(state, {
    tool_calls: [{
      index,
      id: item.call_id,
      type: 'function',
      function: { name: item.name, arguments: '' }
    }]
  })];
}

function handleFuncArgsDelta(evt: any, state: ResponsesToChatState): any[] {
  if (!evt.delta) return [];
  const index = state.outputIndexToToolIndex[Number(evt.output_index)];
  if (index === undefined) return [];
  state.outputIndexToArguments[evt.output_index] = (state.outputIndexToArguments[evt.output_index] || '') + evt.delta;
  return [makeChatDeltaChunk(state, {
    tool_calls: [{ index, function: { arguments: evt.delta } }]
  })];
}

function handleFuncArgsDone(evt: any, state: ResponsesToChatState): any[] {
  const index = state.outputIndexToToolIndex[Number(evt.output_index)];
  if (index === undefined) return [];
  const completed = evt.type === 'response.custom_tool_call_input.done' ? evt.input : evt.arguments;
  const current = state.outputIndexToArguments[evt.output_index] || '';
  if (!completed || !completed.startsWith(current) || completed === current) return [];
  const remainder = completed.slice(current.length);
  state.outputIndexToArguments[evt.output_index] = completed;
  return [makeChatDeltaChunk(state, {
    tool_calls: [{ index, function: { arguments: remainder } }]
  })];
}

function handleReasoningDelta(evt: any, state: ResponsesToChatState): any[] {
  if (!evt.delta) return [];
  return [makeChatDeltaChunk(state, { reasoning_content: evt.delta })];
}

function handleCompleted(evt: any, state: ResponsesToChatState): any[] {
  state.finalized = true;
  let finishReason = 'stop';

  if (isObject(evt.usage)) state.usage = responsesUsageToChatUsage(evt.usage);
  const response = isObject(evt.response) ? evt.response : undefined;
  if (response) {
    if (isObject(response.usage)) state.usage = responsesUsageToChatUsage(response.usage);
    if (response.service_tier) state.serviceTier = response.service_tier;
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason;
      if (reason === 'max_output_tokens') finishReason = 'length';
      else if (reason === 'content_filter') finishReason = 'content_filter';
    } else if (response.status === 'completed' && state.sawToolCall) {
      finishReason = 'tool_calls';
    }
  } else if (state.sawToolCall) {
    finishReason = 'tool_calls';
  }

  const chunks = [makeChatFinishChunk(state, finishReason)];
  if (state.includeUsage && state.usage) chunks.push(makeChatUsageChunk(state));
  return chunks;
}

/** Convert one Responses SSE event into zero or more chat chunks. */
export function responsesEventToChatChunks(event: any, state: ResponsesToChatState): any[] {
  const type = String(event?.type || '');
  switch (type) {
    case 'response.created':
      return handleCreated(event, state);
    case 'response.output_text.delta':
      return handleTextDelta(event, state);
    case 'response.output_item.added':
      return handleOutputItemAdded(event, state);
    case 'response.function_call_arguments.delta':
    case 'response.custom_tool_call_input.delta':
      return handleFuncArgsDelta(event, state);
    case 'response.function_call_arguments.done':
    case 'response.custom_tool_call_input.done':
      return handleFuncArgsDone(event, state);
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      return handleReasoningDelta(event, state);
    case 'response.completed':
    case 'response.done':
    case 'response.incomplete':
    case 'response.failed':
      return handleCompleted(event, state);
    default:
      return [];
  }
}

/**
 * Emit the finish + usage chunks when the stream ended without a terminal
 * event (upstream disconnect). Idempotent.
 */
export function finalizeResponsesChatStream(state: ResponsesToChatState): any[] {
  if (state.finalized) return [];
  state.finalized = true;
  const chunks = [makeChatFinishChunk(state, state.sawToolCall ? 'tool_calls' : 'stop')];
  if (state.includeUsage && state.usage) chunks.push(makeChatUsageChunk(state));
  return chunks;
}

export function chatChunkToSse(chunk: any): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ---------------------------------------------------------------------------
// Buffered accumulator: rebuild output when the terminal event is empty
// ---------------------------------------------------------------------------

export interface BufferedResponseAccumulator {
  text: string;
  reasoning: string;
  funcCalls: { outputIndex: number; callId: string; name: string; args: string }[];
  outputIndexToFuncIdx: Record<number, number>;
}

export function newBufferedResponseAccumulator(): BufferedResponseAccumulator {
  return { text: '', reasoning: '', funcCalls: [], outputIndexToFuncIdx: {} };
}

/** Accumulate output from one Responses SSE event (deltas only). */
export function bufferedAccumulatorProcessEvent(acc: BufferedResponseAccumulator, event: any): void {
  const type = String(event?.type || '');
  if (type === 'response.output_text.delta') {
    if (event.delta) acc.text += event.delta;
  } else if (type === 'response.output_item.added') {
    const item = isObject(event.item) ? event.item : undefined;
    if (item && (item.type === 'function_call' || item.type === 'custom_tool_call')) {
      const index = acc.funcCalls.length;
      acc.outputIndexToFuncIdx[Number(event.output_index)] = index;
      acc.funcCalls.push({ outputIndex: Number(event.output_index), callId: item.call_id || '', name: item.name || '', args: '' });
    }
  } else if (type === 'response.function_call_arguments.delta' || type === 'response.custom_tool_call_input.delta') {
    if (event.delta) {
      const index = acc.outputIndexToFuncIdx[Number(event.output_index)];
      if (index !== undefined) acc.funcCalls[index].args += event.delta;
    }
  } else if (type === 'response.function_call_arguments.done' || type === 'response.custom_tool_call_input.done') {
    const completed = type === 'response.custom_tool_call_input.done' ? event.input : event.arguments;
    if (completed) {
      const index = acc.outputIndexToFuncIdx[Number(event.output_index)];
      if (index !== undefined) acc.funcCalls[index].args = completed;
    }
  } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    if (event.delta) acc.reasoning += event.delta;
  }
}

export function bufferedAccumulatorHasContent(acc: BufferedResponseAccumulator): boolean {
  return acc.text !== '' || acc.funcCalls.length > 0 || acc.reasoning !== '';
}

/** Build a Responses `output` array from accumulated deltas. */
export function bufferedAccumulatorBuildOutput(acc: BufferedResponseAccumulator): any[] {
  const out: any[] = [];
  if (acc.reasoning) out.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: acc.reasoning }] });
  if (acc.text) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: acc.text }] });
  for (const call of acc.funcCalls) {
    out.push({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.args });
  }
  return out;
}

/** Fill empty output (or empty function arguments) from the accumulator. */
export function bufferedAccumulatorSupplementResponseOutput(acc: BufferedResponseAccumulator, resp: any): void {
  if (!resp) return;
  if (!Array.isArray(resp.output) || resp.output.length === 0) {
    if (bufferedAccumulatorHasContent(acc)) resp.output = bufferedAccumulatorBuildOutput(acc);
    return;
  }
  resp.output.forEach((item: any, outputIndex: number) => {
    if (!isObject(item) || item.type !== 'function_call' || item.arguments) return;
    for (const call of acc.funcCalls) {
      const matchesCallId = item.call_id && item.call_id === call.callId;
      if (!matchesCallId && call.outputIndex !== outputIndex) continue;
      if (call.args) item.arguments = call.args;
      break;
    }
  });
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

interface SseFrame {
  event?: string;
  data: string;
}

/**
 * Incremental SSE frame parser. Handles frames split across arbitrary chunk
 * boundaries, `event:` lines, multi-line `data:` fields and comment keepalives.
 */
export class SseFrameParser {
  private buffer = '';

  push(text: string): SseFrame[] {
    this.buffer += text;
    const frames: SseFrame[] = [];
    for (;;) {
      const boundary = findFrameBoundary(this.buffer);
      if (!boundary) break;
      const raw = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const frame = parseSseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  flush(): SseFrame[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const frame = parseSseFrame(this.buffer);
    this.buffer = '';
    return frame ? [frame] : [];
  }
}

function findFrameBoundary(buffer: string): { index: number; length: number } | null {
  const candidates = [buffer.indexOf('\n\n'), buffer.indexOf('\r\n\r\n')].filter(index => index >= 0);
  if (candidates.length === 0) return null;
  const index = Math.min(...candidates);
  const length = buffer.startsWith('\r\n\r\n', index) ? 4 : 2;
  return { index, length };
}

function parseSseFrame(raw: string): SseFrame | null {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0 && !event) return null;
  return { event, data: data.join('\n') };
}

/**
 * Decode one frame into a Responses event object. The `event:` line is used
 * as `type` when the JSON payload omits it.
 */
export function frameToResponsesEvent(frame: SseFrame): any | null {
  const data = frame.data.trim();
  if (!data || data === '[DONE]') return null;
  let payload: any;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(payload)) return null;
  if (!payload.type && frame.event) payload.type = frame.event;
  return payload;
}

const TERMINAL_RESPONSE_EVENTS = new Set(['response.completed', 'response.done', 'response.incomplete', 'response.failed']);

function chatErrorBody(message: string): any {
  return { error: { message, type: 'upstream_error', param: null, code: null } };
}

/**
 * Translate a Responses SSE stream into a Chat Completions SSE stream for a
 * streaming client. Appends the OpenAI `data: [DONE]` sentinel on flush.
 */
export function responsesSseToChatStream(
  body: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const state = newResponsesToChatState(model);
  const parser = new SseFrameParser();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Loop until something is enqueued: the stream only calls pull again
        // after a chunk is produced, so returning empty (a partial SSE frame)
        // would deadlock the reader.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            for (const frame of parser.flush()) {
              const event = frameToResponsesEvent(frame);
              if (event) {
                for (const chunk of responsesEventToChatChunks(event, state)) controller.enqueue(encoder.encode(chatChunkToSse(chunk)));
              }
            }
            for (const chunk of finalizeResponsesChatStream(state)) controller.enqueue(encoder.encode(chatChunkToSse(chunk)));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }
          let produced = false;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            const event = frameToResponsesEvent(frame);
            if (!event) continue;
            for (const chunk of responsesEventToChatChunks(event, state)) {
              controller.enqueue(encoder.encode(chatChunkToSse(chunk)));
              produced = true;
            }
          }
          if (produced) return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // Upstream already gone; nothing to release.
      }
    }
  });
}

export interface BufferedBridgeResult {
  body: any;
  status: number;
}

/**
 * Buffer a Responses SSE stream into a single Chat Completions JSON response
 * for a non-streaming client. The terminal event supplies output and usage;
 * the accumulator covers terminals that arrive empty.
 */
export async function bufferResponsesSseAsChat(
  body: ReadableStream<Uint8Array>,
  model: string
): Promise<BufferedBridgeResult> {
  const acc = newBufferedResponseAccumulator();
  const parser = new SseFrameParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();

  let terminal: any = null;
  let sawSse = false;
  let rawText = '';

  const handleFrame = (frame: SseFrame) => {
    const event = frameToResponsesEvent(frame);
    if (!event) return;
    sawSse = true;
    bufferedAccumulatorProcessEvent(acc, event);
    if (TERMINAL_RESPONSE_EVENTS.has(String(event.type))) terminal = event;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (!sawSse) rawText += text;
    for (const frame of parser.push(text)) handleFrame(frame);
  }
  for (const frame of parser.flush()) handleFrame(frame);

  if (!sawSse && !terminal) {
    // Upstream ignored stream=true and returned a plain JSON body.
    const parsed = safeJson(rawText);
    if (isObject(parsed) && (parsed.output !== undefined || parsed.object === 'response')) {
      return { body: responsesToChatCompletion(parsed, model), status: 200 };
    }
    return { body: chatErrorBody('Upstream returned an unparseable response'), status: 502 };
  }

  if (!terminal) {
    return { body: chatErrorBody('Upstream stream ended without a terminal response event'), status: 502 };
  }

  if (String(terminal.type) === 'response.failed') {
    const message = terminal.response?.error?.message || 'Upstream response failed';
    return { body: chatErrorBody(message), status: 502 };
  }

  const response = isObject(terminal.response) ? terminal.response : {};
  bufferedAccumulatorSupplementResponseOutput(acc, response);
  return { body: responsesToChatCompletion(response, model), status: 200 };
}

function safeJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
