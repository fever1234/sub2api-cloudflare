// The chat ⇄ responses bridge for opencode_go models (muse-spark/grok/gpt).
//
// This suite exists because the conversion runs on a path no other test
// exercises: a Chat Completions client reaching a Responses-native upstream.
// A dropped field here (session key, usage) or a stream that never terminates
// shows up only as a mystery 404/hang in production, so the rules, the request
// shape and both stream shapes are asserted against the module itself.
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('PASS', name) }
  else { failures.push(`${name} ${detail}`); console.log('FAIL', name, detail) }
}

const outDir = mkdtempSync(join(tmpdir(), 'sub2api-bridge-'))
const outFile = join(outDir, 'bridge.mjs')
const compatFile = join(outDir, 'compat.mjs')
await build({
  entryPoints: ['functions/src/utils/responses-bridge.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: outFile, logLevel: 'silent'
})
await build({
  entryPoints: ['functions/src/utils/responses-compat.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: compatFile, logLevel: 'silent'
})
const silentFile = join(outDir, 'silent.mjs')
await build({
  entryPoints: ['functions/src/utils/silent-refusal.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: silentFile, logLevel: 'silent'
})
const allowlistFile = join(outDir, 'allowlist.mjs')
await build({
  entryPoints: ['functions/src/utils/model-allowlist.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: allowlistFile, logLevel: 'silent'
})
const bridge = await import(pathToFileURL(outFile).href)
const compat = await import(pathToFileURL(compatFile).href)
const silent = await import(pathToFileURL(silentFile).href)
const allowlist = await import(pathToFileURL(allowlistFile).href)
rmSync(outDir, { recursive: true, force: true })

const {
  normalizeOpenCodeModelId,
  openCodeGoModelProtocol,
  chatCompletionsToResponses,
  responsesToChatCompletion,
  newResponsesToChatState,
  responsesEventToChatChunks,
  finalizeResponsesChatStream,
  SseFrameParser,
  frameToResponsesEvent,
  responsesSseToChatStream,
  bufferResponsesSseAsChat,
} = bridge

// ---- protocol rule table ---------------------------------------------------
// muse-spark is the model this bridge exists for.
check('muse-spark-1.3 is responses-native', openCodeGoModelProtocol('muse-spark-1.3') === 'responses')
check('grok-4.7 is responses-native', openCodeGoModelProtocol('grok-4.7') === 'responses')
check('gpt-5.6-luna is responses-native', openCodeGoModelProtocol('gpt-5.6-luna') === 'responses')
check('glm-5.3 stays chat_completions', openCodeGoModelProtocol('glm-5.3') === 'chat_completions')
check('kimi-k3 stays chat_completions', openCodeGoModelProtocol('kimi-k3') === 'chat_completions')
check('minimax-m3 is anthropic-native', openCodeGoModelProtocol('minimax-m3') === 'anthropic')
check('qwen3.8-max is anthropic-native', openCodeGoModelProtocol('qwen3.8-max') === 'anthropic')
// An unknown future model must default to chat so new OpenCode models work
// without a code change.
check('unknown future model defaults to chat_completions', openCodeGoModelProtocol('glm-6-somebrand-new') === 'chat_completions')
// The opencode/ vendor prefix must not defeat pattern matching.
check('opencode/muse-spark prefix normalizes', normalizeOpenCodeModelId('opencode/muse-spark-1.3') === 'muse-spark-1.3')
check('prefixed muse-spark still resolves to responses', openCodeGoModelProtocol('opencode/muse-spark-1.3') === 'responses')
check('pattern match is case-insensitive', openCodeGoModelProtocol('MUSE-SPARK-1.3') === 'responses')

// ---- request conversion ----------------------------------------------------
const chatRequest = {
  model: 'muse-spark-1.3',
  stream: false,
  messages: [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' }
  ],
  temperature: 0.7,
  top_p: 0.9,
  max_tokens: 64,
  prompt_cache_key: 'sess-abc',
  stop: ['\n\n'],
  user: 'alice',
  stream_options: { include_usage: true }
}
const responsesRequest = chatCompletionsToResponses(chatRequest)
check('stream is forced on for upstream', responsesRequest.stream === true, responsesRequest.stream)
check('model is kept as the client asked', responsesRequest.model === 'muse-spark-1.3')
check('store is disabled', responsesRequest.store === false)
check('encrypted reasoning is requested', JSON.stringify(responsesRequest.include) === '["reasoning.encrypted_content"]')
check('messages become input items', Array.isArray(responsesRequest.input) && responsesRequest.input.length === 2)
check('no chat-only messages key leaks', responsesRequest.messages === undefined)
check('system message maps to a system input item', responsesRequest.input[0].role === 'system' && responsesRequest.input[0].content === 'be terse')
check('user message maps to a user input item', responsesRequest.input[1].role === 'user')
check('muse-spark keeps temperature (not a reasoning-only model)', responsesRequest.temperature === 0.7)
check('top_p is preserved', responsesRequest.top_p === 0.9)
check('prompt_cache_key survives (session key)', responsesRequest.prompt_cache_key === 'sess-abc')
check('stop sequences are preserved', JSON.stringify(responsesRequest.stop) === JSON.stringify(['\n\n']))
check('user field is preserved', responsesRequest.user === 'alice')
check('chat-only stream_options is dropped', responsesRequest.stream_options === undefined)
// max_tokens below the upstream floor gets raised to 128.
const floored = chatCompletionsToResponses({ model: 'muse-spark-1.3', messages: [], max_tokens: 64 })
check('max_output_tokens is floored to 128', floored.max_output_tokens === 128, floored.max_output_tokens)
const notFloored = chatCompletionsToResponses({ model: 'muse-spark-1.3', messages: [], max_tokens: 4096 })
check('large max_tokens passes through untouched', notFloored.max_output_tokens === 4096)

// reasoning models drop sampling params.
const gpt5 = chatCompletionsToResponses({ model: 'gpt-5.6-luna', messages: [], temperature: 0.5, top_p: 0.9 })
check('gpt-5.x drops temperature', gpt5.temperature === undefined)
check('gpt-5.x drops top_p', gpt5.top_p === undefined)
const effort = chatCompletionsToResponses({ model: 'muse-spark-1.3', messages: [], reasoning_effort: 'high' })
check('reasoning_effort maps to a reasoning block', effort.reasoning?.effort === 'high' && effort.reasoning?.summary === 'auto')

// response_format json_schema is unwrapped into text.format.
const fmt = chatCompletionsToResponses({
  model: 'muse-spark-1.3',
  messages: [],
  response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' } } }
})
check('json_schema unwraps into text.format', fmt.text?.format?.type === 'json_schema' && fmt.text?.format?.name === 'out')

// tools flatten to the Responses shape.
const tools = chatCompletionsToResponses({
  model: 'muse-spark-1.3',
  messages: [],
  tools: [{ type: 'function', function: { name: 'get', description: 'd', parameters: { type: 'object' } } }],
  tool_choice: 'auto'
})
check('tools flatten to Responses function tools', tools.tools?.[0]?.type === 'function' && tools.tools?.[0]?.name === 'get')
check('tool_choice passes through', tools.tool_choice === 'auto')

// Chat's nested forced-tool spelling must flatten to the Responses shape.
const nestedChoice = chatCompletionsToResponses({
  model: 'muse-spark-1.3',
  messages: [],
  tools: [{ type: 'function', function: { name: 'get' } }],
  tool_choice: { type: 'function', function: { name: 'get' } }
})
check('nested tool_choice flattens to Responses form',
  nestedChoice.tool_choice?.type === 'function' && nestedChoice.tool_choice?.name === 'get' && nestedChoice.tool_choice?.function === undefined)
const flatChoice = chatCompletionsToResponses({
  model: 'muse-spark-1.3',
  messages: [],
  tools: [{ type: 'function', function: { name: 'get' } }],
  tool_choice: { type: 'function', name: 'get' }
})
check('already-flat tool_choice stays untouched',
  flatChoice.tool_choice?.name === 'get' && flatChoice.tool_choice?.function === undefined)
check('tool_choice any/required string forms survive',
  chatCompletionsToResponses({ model: 'm', messages: [], tool_choice: 'required' }).tool_choice === 'required')

// Conversation history: assistant tool_calls and tool results must round-trip.
const history = chatCompletionsToResponses({
  model: 'muse-spark-1.3',
  messages: [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get', arguments: '{"city":"SF"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
  ]
})
check('assistant tool_call becomes a function_call item', history.input[1].type === 'function_call' && history.input[1].call_id === 'call_1')
check('assistant tool_call arguments survive', history.input[1].arguments === '{"city":"SF"}')
check('tool result becomes function_call_output', history.input[2].type === 'function_call_output' && history.input[2].output === 'sunny')

// ---- non-streaming response conversion ------------------------------------
const responsesResponse = {
  id: 'resp_123',
  status: 'completed',
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    { type: 'function_call', call_id: 'call_9', name: 'get', arguments: '{}' }
  ],
  usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, output_tokens_details: { reasoning_tokens: 2 } }
}
const chatResponse = responsesToChatCompletion(responsesResponse, 'muse-spark-1.3')
check('converted response is a chat.completion', chatResponse.object === 'chat.completion')
check('converted response echoes the client model', chatResponse.model === 'muse-spark-1.3')
check('converted response keeps the upstream id', chatResponse.id === 'resp_123')
check('converted content is plain text', chatResponse.choices[0].message.content === 'hi there')
check('converted tool_calls keep name and arguments', chatResponse.choices[0].message.tool_calls?.[0]?.function?.name === 'get')
check('tool-call response finishes with tool_calls', chatResponse.choices[0].finish_reason === 'tool_calls')
check('usage maps input/output tokens to prompt/completion', chatResponse.usage?.prompt_tokens === 7 && chatResponse.usage?.completion_tokens === 3 && chatResponse.usage?.total_tokens === 10)
check('reasoning tokens land in completion details', chatResponse.usage?.completion_tokens_details?.reasoning_tokens === 2)

const textOnly = responsesToChatCompletion({
  id: 'resp_t', status: 'incomplete',
  incomplete_details: { reason: 'max_output_tokens' },
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'trunc' }] }],
  usage: { input_tokens: 1, output_tokens: 2 }
}, 'muse-spark-1.3')
check('max_output_tokens maps finish_reason to length', textOnly.choices[0].finish_reason === 'length')
check('incomplete response still carries text', textOnly.choices[0].message.content === 'trunc')

// ---- streaming state machine ----------------------------------------------
const state = newResponsesToChatState('muse-spark-1.3')
let chunks = responsesEventToChatChunks({ type: 'response.created', response: { id: 'resp_s', service_tier: 'default' } }, state)
check('response.created emits exactly one role chunk', chunks.length === 1 && chunks[0].choices[0].delta.role === 'assistant')
check('role chunk uses the client model', chunks[0].model === 'muse-spark-1.3')
chunks = responsesEventToChatChunks({ type: 'response.output_text.delta', delta: 'Hello' }, state)
check('text delta becomes a content chunk', chunks.length === 1 && chunks[0].choices[0].delta.content === 'Hello')

// Tool call: added → args delta → args done (no duplicate) → terminal.
chunks = responsesEventToChatChunks({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'get' } }, state)
check('tool call announces id, name and empty args', chunks[0].choices[0].delta.tool_calls?.[0]?.id === 'c1' && chunks[0].choices[0].delta.tool_calls?.[0]?.function?.name === 'get')
chunks = responsesEventToChatChunks({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"ci' }, state)
check('args delta forwards incrementally', chunks[0].choices[0].delta.tool_calls?.[0]?.function?.arguments === '{"ci')
chunks = responsesEventToChatChunks({ type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"city":"SF"}' }, state)
check('args done forwards only the remainder', chunks[0].choices[0].delta.tool_calls?.[0]?.function?.arguments === 'ty":"SF"}')
chunks = responsesEventToChatChunks({ type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"city":"SF"}' }, state)
check('repeat args done emits nothing (no duplicate)', chunks.length === 0)

chunks = responsesEventToChatChunks({
  type: 'response.completed',
  response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 5 } }
}, state)
check('terminal emits a finish chunk', chunks[0]?.choices?.[0]?.finish_reason === 'tool_calls')
check('terminal emits a usage chunk', chunks[1]?.usage?.prompt_tokens === 4 && chunks[1]?.usage?.completion_tokens === 5)
check('finish chunk carries no usage (billing scans near tail)', chunks[0].usage === undefined)
check('finalize is idempotent after a terminal', finalizeResponsesChatStream(state).length === 0)

// The finalize helper still emits a stop chunk for callers that want to end an
// unfinished stream deliberately; the live client stream no longer uses it —
// see the stream-level tests below.
const orphan = newResponsesToChatState('muse-spark-1.3')
responsesEventToChatChunks({ type: 'response.created', response: {} }, orphan)
const orphanChunks = finalizeResponsesChatStream(orphan)
check('orphan stream still finalizes with a stop chunk', orphanChunks[0].choices[0].finish_reason === 'stop')
check('orphan finalize is idempotent', finalizeResponsesChatStream(orphan).length === 0)

// ---- SSE frame parsing -----------------------------------------------------
const parser = new SseFrameParser()
let frames = parser.push('data: {"type":"response.output_text.del')
check('incomplete frame is held back', frames.length === 0)
frames = parser.push('ta","delta":"hi"}\n\ndata: [DONE]\n\n')
check('frame completes across chunk boundaries', frames.length === 2)
check('frame data parses to an event', frameToResponsesEvent(frames[0])?.delta === 'hi')
check('the [DONE] sentinel is ignored', frameToResponsesEvent(frames[1]) === null)

const eventLine = new SseFrameParser().push('event: response.completed\ndata: {"status":"completed"}\n\n')[0]
check('event: line fills a missing type', frameToResponsesEvent(eventLine)?.type === 'response.completed')

// ---- streaming bridge (client-facing SSE) ---------------------------------
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const upstreamSse = [
  'data: {"type":"response.created","response":{"id":"resp_f"}}\n\n',
  'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
  'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Hi"}]}],"usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
  'data: [DONE]\n\n'
].join('')

async function readAll(stream) {
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

// Feed the upstream bytes in awkward slices to prove frame reassembly.
const sliced = upstreamSse.match(/[\s\S]{1,7}/g) || []
const source = new ReadableStream({
  start(controller) {
    for (const slice of sliced) controller.enqueue(encoder.encode(slice))
    controller.close()
  }
})
const streamed = await readAll(responsesSseToChatStream(source, 'muse-spark-1.3'))
const streamLines = streamed.trim().split('\n')
const streamChunks = streamLines.filter(l => l.startsWith('data: ') && !l.includes('[DONE]')).map(l => JSON.parse(l.slice(6)))
check('client stream starts with a role chunk', streamChunks[0].choices?.[0]?.delta?.role === 'assistant')
check('client stream forwards text deltas', streamChunks.some(c => c.choices?.[0]?.delta?.content === 'Hi'))
const withChoices = streamChunks.filter(c => Array.isArray(c.choices) && c.choices.length > 0)
check('client stream ends with a finish chunk', withChoices[withChoices.length - 1].choices[0].finish_reason === 'stop')
check('client stream carries usage near the tail', streamChunks[streamChunks.length - 1]?.usage?.prompt_tokens === 7)
check('client stream appends the [DONE] sentinel', streamLines[streamLines.length - 1] === 'data: [DONE]')
check('client stream chunks keep the client model', streamChunks.every(c => c.model === 'muse-spark-1.3'))

// ---- buffered (non-streaming) bridge --------------------------------------
const buffered = await bufferResponsesSseAsChat(
  new ReadableStream({ start(c) { c.enqueue(encoder.encode(upstreamSse)); c.close() } }),
  'muse-spark-1.3'
)
check('buffered bridge returns 200', buffered.status === 200)
check('buffered bridge returns chat JSON', buffered.body.object === 'chat.completion')
check('buffered bridge content matches the terminal', buffered.body.choices[0].message.content === 'Hi')
check('buffered bridge usage matches the terminal', buffered.body.usage.prompt_tokens === 7 && buffered.body.usage.completion_tokens === 3)

// Terminal events that arrive with empty output are rebuilt from deltas.
const emptyTerminal = [
  'data: {"type":"response.created","response":{}}\n\n',
  'data: {"type":"response.output_text.delta","delta":"from deltas"}\n\n',
  'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":2}}}\n\n'
].join('')
const supplemented = await bufferResponsesSseAsChat(
  new ReadableStream({ start(c) { c.enqueue(encoder.encode(emptyTerminal)); c.close() } }),
  'muse-spark-1.3'
)
check('empty terminal is supplemented from deltas', supplemented.body.choices[0].message.content === 'from deltas')

// A failed upstream response must not be reported as success.
const failed = await bufferResponsesSseAsChat(
  new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: {"type":"response.failed","response":{"error":{"message":"model overloaded"}}}\n\n')); c.close() } }),
  'muse-spark-1.3'
)
check('failed upstream maps to a 502', failed.status === 502)
check('failed upstream keeps the upstream message', failed.body.error.message === 'model overloaded')

// A truncated stream must not hang the client as a 200 with empty content.
const truncated = await bufferResponsesSseAsChat(
  new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: {"type":"response.created","response":{}}\n\n')); c.close() } }),
  'muse-spark-1.3'
)
check('stream without a terminal maps to a 502', truncated.status === 502)

// ---- stream-level terminal semantics ---------------------------------------
// The live stream must break rather than fabricate a stop: a truncated answer
// handed back as complete is worse than an error the client can retry (and,
// pre-Response, one the gateway can fail over to another account).
async function expectStreamError(stream) {
  const reader = stream.getReader()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return { errored: false, message: '', text }
  } catch (error) {
    return { errored: true, message: String(error?.message || error), text }
  }
}

const orphanSource = new ReadableStream({
  start(c) {
    c.enqueue(encoder.encode('data: {"type":"response.created","response":{}}\n\n'))
    c.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'))
    c.close()
  }
})
const orphanResult = await expectStreamError(responsesSseToChatStream(orphanSource, 'muse-spark-1.3'))
check('live stream without a terminal event errors instead of finishing',
  orphanResult.errored === true, JSON.stringify(orphanResult))
check('stream error names the missing terminal',
  /terminal/.test(orphanResult.message), orphanResult.message)
check('unterminated stream never emits [DONE]',
  !orphanResult.text.includes('[DONE]'), orphanResult.text.slice(-80))

const failedSource = new ReadableStream({
  start(c) {
    c.enqueue(encoder.encode('data: {"type":"response.created","response":{}}\n\n'))
    c.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"x"}\n\n'))
    c.enqueue(encoder.encode('data: {"type":"response.failed","response":{"error":{"message":"model overloaded"}}}\n\n'))
    c.close()
  }
})
const failedResult = await expectStreamError(responsesSseToChatStream(failedSource, 'muse-spark-1.3'))
check('response.failed errors the stream with the upstream message',
  failedResult.errored === true && failedResult.message === 'model overloaded', JSON.stringify(failedResult))
check('response.failed never fabricates finish_reason stop',
  !failedResult.text.includes('"finish_reason":"stop"'), failedResult.text.slice(-200))

// ---- Responses 400 field-strip retry ---------------------------------------
// Relays reject valid Responses bodies for fields their schema does not model;
// the gateway drops exactly the named field and re-sends, bounded by a shared
// per-request budget (Go: openai_responses_rejected_field_retry.go).
const { stripRejectedResponseFields, createStripRetryState, sendWithRejectedFieldRetry } = compat
const stripJson = (obj) => JSON.stringify(obj)
const stripErr = (error) => JSON.stringify({ error })

let strip = stripRejectedResponseFields(
  stripErr({ message: "Unknown parameter: 'max_output_tokens'.", code: 'unknown_parameter', param: 'max_output_tokens' }),
  stripJson({ model: 'gpt-5', max_output_tokens: 100, input: [] })
)
check('strip drops rejected max_output_tokens',
  !!strip && JSON.parse(strip.body).max_output_tokens === undefined
    && Array.isArray(JSON.parse(strip.body).input) && JSON.parse(strip.body).model === 'gpt-5',
  JSON.stringify(strip))

strip = stripRejectedResponseFields(
  stripErr({ message: 'unsupported parameter: truncation' }),
  stripJson({ model: 'gpt-5', truncation: true })
)
check('message-only rejection strips named top-level field',
  !!strip && JSON.parse(strip.body).truncation === undefined)

strip = stripRejectedResponseFields(
  stripErr({ message: "Unknown parameter: 'input[0].namespace'.", code: 'unknown_parameter', param: 'input[0].namespace' }),
  stripJson({ model: 'gpt-5', input: [
    { type: 'function_call', call_id: 'c1', namespace: 'ns' },
    { type: 'function_call', call_id: 'c2' }
  ] })
)
check('strip removes namespace from the rejected item only',
  !!strip && JSON.parse(strip.body).input[0].namespace === undefined
    && JSON.parse(strip.body).input[1].call_id === 'c2')

// One status per round trip would exhaust the budget on a replayed chat, so
// every item of the rejected type loses its status together.
strip = stripRejectedResponseFields(
  stripErr({ message: "Unknown parameter: 'input[0].status'.", code: 'unknown_parameter', param: 'input[0].status' }),
  stripJson({ model: 'gpt-5', input: [
    { type: 'message', role: 'user', status: 'ok' },
    { type: 'message', role: 'assistant', status: 'ok' },
    { type: 'function_call', call_id: 'c', status: 'pending' }
  ] })
)
check('status rejection clears every item of the rejected type',
  !!strip && JSON.parse(strip.body).input[0].status === undefined
    && JSON.parse(strip.body).input[1].status === undefined
    && JSON.parse(strip.body).input[2].status === 'pending')

strip = stripRejectedResponseFields(
  stripErr({ message: 'prompt_cache_breakpoint is not supported on this model', code: 'invalid_parameter', param: 'prompt_cache_breakpoint' }),
  stripJson({ model: 'gpt-5', prompt_cache_breakpoint: 3 })
)
check('cache-model rejection strips top-level breakpoint',
  !!strip && JSON.parse(strip.body).prompt_cache_breakpoint === undefined)

strip = stripRejectedResponseFields(
  stripErr({ message: 'input[1].prompt_cache_breakpoint is not supported on this model' }),
  stripJson({ model: 'gpt-5', input: [{ type: 'message' }, { type: 'message', prompt_cache_breakpoint: 2 }] })
)
check('cache-model rejection strips the indexed breakpoint',
  !!strip && JSON.parse(strip.body).input[1].prompt_cache_breakpoint === undefined
    && JSON.parse(strip.body).prompt_cache_breakpoint === undefined)

strip = stripRejectedResponseFields(
  stripErr({ message: 'invalid type for input[0].content: expected string, got null', code: 'invalid_type', param: 'input[0].content' }),
  stripJson({ model: 'gpt-5', input: [{ type: 'reasoning', content: null }, { type: 'message', role: 'user', content: null }] })
)
check('null content on a reasoning item is dropped',
  !!strip && JSON.parse(strip.body).input[0].content === undefined)

strip = stripRejectedResponseFields(
  stripErr({ message: 'invalid type for input[1].content: expected string, got null', code: 'invalid_type', param: 'input[1].content' }),
  stripJson({ model: 'gpt-5', input: [{ type: 'reasoning', content: [{ type: 'text' }] }, { type: 'message', role: 'user', content: null }] })
)
check('null content on a message item normalizes to empty string',
  !!strip && JSON.parse(strip.body).input[1].content === '')

strip = stripRejectedResponseFields(
  stripErr({ message: 'invalid "input[1].content": array too long. Maximum length 0', code: 'array_above_max_length', param: 'input[1].content' }),
  stripJson({ model: 'gpt-5', input: [{ type: 'message' }, { type: 'reasoning', content: [{ type: 'summary_text' }] }] })
)
check('over-limit reasoning content is dropped',
  !!strip && JSON.parse(strip.body).input[1].content === undefined)

strip = stripRejectedResponseFields(
  stripErr({ message: 'invalid function parameters for tools[0].parameters: got type: none', code: 'invalid_function_parameters', param: 'tools[0].parameters' }),
  stripJson({ model: 'gpt-5', tools: [{ type: 'function', name: 'f', parameters: { type: null, properties: {} } }] })
)
check('tool parameter root null type is repaired to object',
  !!strip && JSON.parse(strip.body).tools[0].parameters.type === 'object')

// Param and message disagreeing means the message was not authored about this
// body: stripping on it would silently mutate an unrelated field.
strip = stripRejectedResponseFields(
  stripErr({ message: 'unknown parameter: truncation', code: 'unknown_parameter', param: 'max_output_tokens' }),
  stripJson({ model: 'gpt-5', max_output_tokens: 10, truncation: true })
)
check('param/message mismatch refuses to strip', strip === null)

strip = stripRejectedResponseFields(
  stripErr({ message: 'Rate limit exceeded', code: 'rate_limit_exceeded' }),
  stripJson({ model: 'gpt-5', max_output_tokens: 10 })
)
check('unrecognized 400 leaves the body untouched', strip === null)
check('non-JSON error body is refused', stripRejectedResponseFields('not json', stripJson({ model: 'g' })) === null)

// Retry driver: a strippable 400 re-sends once and the success flows through.
{
  const original = stripJson({ model: 'gpt-5', max_output_tokens: 100 })
  const state = createStripRetryState(original)
  const errText = stripErr({ message: "Unknown parameter: 'max_output_tokens'.", code: 'unknown_parameter', param: 'max_output_tokens' })
  const sends = []
  const sender = async (bodyText) => {
    sends.push(bodyText)
    if (sends.length === 1) {
      return { status: 400, headers: { 'content-type': 'application/json' }, body: null, text: async () => errText }
    }
    return { status: 200, headers: {}, body: null, text: async () => 'ok' }
  }
  const result = await sendWithRejectedFieldRetry(sender, original, state)
  check('strip retry re-sends the rewritten body', result.status === 200 && sends.length === 2, `status=${result.status} sends=${sends.length}`)
  check('re-sent body has the rejected field removed', !!sends[1] && !JSON.parse(sends[1]).max_output_tokens)
}

// A 400 that never becomes strippable still reaches the caller intact.
{
  const state = createStripRetryState(stripJson({ model: 'gpt-5' }))
  const errText = stripErr({ message: 'Rate limit exceeded', code: 'rate_limit_exceeded' })
  let sends = 0
  const result = await sendWithRejectedFieldRetry(async () => {
    sends += 1
    return { status: 400, headers: { 'content-type': 'application/json' }, body: null, text: async () => errText }
  }, stripJson({ model: 'gpt-5' }), state)
  check('non-strippable 400 is passed through with its body',
    sends === 1 && result.status === 400 && await result.text() === errText, `sends=${sends}`)
}

// The budget is shared across the whole client request: after the sixth strip
// the driver stops, so a hostile upstream cannot loop the gateway forever.
{
  const items = Array.from({ length: 9 }, (_, i) => ({ type: 'function_call', call_id: `c${i}`, namespace: `ns${i}` }))
  const original = stripJson({ model: 'gpt-5', input: items })
  const state = createStripRetryState(original)
  let sends = 0
  const result = await sendWithRejectedFieldRetry(async (bodyText) => {
    sends += 1
    const parsed = JSON.parse(bodyText)
    const idx = parsed.input.findIndex(item => item.namespace !== undefined)
    if (idx === -1) return { status: 200, headers: {}, body: null, text: async () => 'ok' }
    const errText = stripErr({ message: `unknown parameter: input[${idx}].namespace`, code: 'unknown_parameter', param: `input[${idx}].namespace` })
    return { status: 400, headers: { 'content-type': 'application/json' }, body: null, text: async () => errText }
  }, original, state)
  check('strip retries stop at the shared budget', result.status === 400 && sends === 7, `status=${result.status} sends=${sends}`)
}

// Without a budget (or body) the driver is a single pass.
{
  let sends = 0
  const result = await sendWithRejectedFieldRetry(async () => {
    sends += 1
    return { status: 400, headers: {}, body: null, text: async () => 'err' }
  }, stripJson({ model: 'gpt-5' }), undefined)
  check('no state means no retry', sends === 1 && result.status === 400)
}

// ---- OpenAI silent-refusal detection ---------------------------------------
// A long request can be answered with a stream that stops on finish_reason=stop
// carrying nothing: the gateway must fail it over, not serve it. Detection is
// size-gated and buffers output so the client never sees a refused stream
// (Go: openai_silent_refusal.go).
const {
  SilentRefusalDetector,
  guardSilentRefusalStream,
  SILENT_REFUSAL_MIN_BODY_BYTES,
  SILENT_REFUSAL_UPSTREAM_MESSAGE,
} = silent
const sse = (frames) => new TextEncoder().encode(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n')
const chatRefusalFrames = [
  { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
  { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
]
const chatContentFrames = [
  { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] },
  { id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } },
]
const toStream = (bytes) => new ReadableStream({
  start(controller) { controller.enqueue(bytes); controller.close() }
})
const splitStream = (bytes, sizes) => {
  const encoder = () => new ReadableStream({
    start(controller) {
      let offset = 0
      let i = 0
      while (offset < bytes.length) {
        const size = sizes[i % sizes.length]
        controller.enqueue(bytes.slice(offset, offset + size))
        offset += size
        i += 1
      }
      controller.close()
    }
  })
  return encoder()
}
async function readError(stream) {
  const reader = stream.getReader()
  for (;;) {
    try {
      const { done } = await reader.read()
      if (done) return null
    } catch (error) {
      return error
    }
  }
}

check('silent refusal detection is disabled below 64KB', new SilentRefusalDetector(64 * 1024 - 1).enabled === false)
check('silent refusal detection arms at 64KB', new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES).enabled === true)
check('a non-openai provider keeps the detector disarmed', new SilentRefusalDetector(10 * 1024 * 1024, false).enabled === false)
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  for (const frame of chatRefusalFrames) detector.observePayload(JSON.stringify(frame))
  detector.observePayload('[DONE]')
  check('chat finish=stop with nothing else is a silent refusal',
    detector.isSilentRefusal() === true && detector.shouldReleaseClientOutput() === false)
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  detector.observePayload(JSON.stringify(chatContentFrames[1]))
  check('a usage frame releases the stream and defeats refusal',
    detector.shouldReleaseClientOutput() === true && detector.isSilentRefusal() === false)
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  detector.observePayload(JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }))
  check('content defeats refusal even on finish=stop', detector.isSilentRefusal() === false && detector.shouldReleaseClientOutput() === true)
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  detector.observePayload(JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }))
  check('finish=length releases instead of refusing',
    detector.shouldReleaseClientOutput() === true && detector.isSilentRefusal() === false)
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  detector.observePayload(JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: 'hmm' } }] }))
  check('reasoning alone releases the stream', detector.shouldReleaseClientOutput() === true && detector.isSilentRefusal() === false)
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  detector.observePayload(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } }))
  check('empty response.completed is a silent refusal',
    detector.isSilentRefusal() === true && detector.shouldReleaseClientOutput() === false)
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  detector.observePayload(JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, output: [] }
  }))
  check('response.completed with usage is served', detector.isSilentRefusal() === false && detector.shouldReleaseClientOutput() === true)
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  detector.observePayload(JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }
  }))
  check('response.completed with output text is served', detector.isSilentRefusal() === false && detector.shouldReleaseClientOutput() === true)
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  detector.observePayload(JSON.stringify({ type: 'error', error: { message: 'boom' } }))
  check('an error frame releases the stream', detector.shouldReleaseClientOutput() === true && detector.isSilentRefusal() === false)
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  detector.observeEventType('response.failed')
  check('response.failed event type counts as an error', detector.isSilentRefusal() === false && detector.shouldReleaseClientOutput() === true)
}
// Guard: a refused stream must error with the failover message and send nothing.
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  const error = await readError(guardSilentRefusalStream(toStream(sse(chatRefusalFrames)), detector))
  check('guard refuses a finish=stop empty chat stream',
    !!error && error.message === SILENT_REFUSAL_UPSTREAM_MESSAGE, String(error))
}
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  const bytes = sse(chatContentFrames)
  const text = await readAll(guardSilentRefusalStream(toStream(bytes), detector))
  check('guard releases a stream that carries content',
    text.includes('hi') && text.includes('[DONE]'), text)
}
{
  const detector = new SilentRefusalDetector(1024)
  const source = toStream(sse(chatRefusalFrames))
  check('a disarmed detector passes the stream through untouched',
    guardSilentRefusalStream(source, detector) === source)
}
// Frames split across byte chunks must still be observed.
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  const error = await readError(guardSilentRefusalStream(splitStream(sse(chatRefusalFrames), [7, 13, 5, 29]), detector))
  check('refusal is detected across chunk boundaries',
    !!error && error.message === SILENT_REFUSAL_UPSTREAM_MESSAGE, String(error))
}
// A stream that ends without ever finishing must not be swallowed: the bytes
// are flushed as they arrived.
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  const partial = new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n')
  const text = await readAll(guardSilentRefusalStream(toStream(partial), detector))
  check('an unfinished stream fails open with its bytes intact',
    text.includes('"role":"assistant"'), text)
}
// Past the buffer cap the stream is released rather than held forever.
{
  const detector = new SilentRefusalDetector(SILENT_REFUSAL_MIN_BODY_BYTES)
  const filler = 'data: ' + 'x'.repeat(900) + '\n\n'
  const big = new TextEncoder().encode(filler.repeat(1300))  // ~1.2MB, no positive signal
  const text = await readAll(guardSilentRefusalStream(toStream(big), detector))
  check('the buffer cap fails open instead of hanging', text.length >= 1024 * 1024, text.length)
}

// ---- group model allowlist --------------------------------------------------
// A key's group may pin which models it can list, retrieve and generate; a
// denied model must read as nonexistent (Go: group_model_allowlist.go).
const {
  normalizeModelAllowlist,
  parseModelAllowlist,
  modelAllowed,
  modelAllowlistDenied,
} = allowlist
const groupWith = (enabled, list) => ({
  id: 1, name: 'g', enabled: 1, priority: 0, error_threshold: 0.5,
  error_count_threshold: 3, window_seconds: 300, created_at: '',
  model_allowlist_enabled: enabled,
  model_allowlist: typeof list === 'string' ? list : JSON.stringify(list || []),
})

let normalized = normalizeModelAllowlist([' gpt-4o ', 'GPT-4O', '', 'gpt-*'])
check('allowlist normalization trims and dedupes case-insensitively',
  !normalized.error && JSON.stringify(normalized.list) === JSON.stringify(['gpt-4o', 'gpt-*']),
  JSON.stringify(normalized))
check('mid-string wildcard is rejected',
  normalizeModelAllowlist(['gpt-*-turbo']).error !== undefined)
check('bare wildcard is rejected', normalizeModelAllowlist(['*']).error !== undefined)
check('non-array allowlist is rejected', normalizeModelAllowlist('gpt-4o').error !== undefined)
check('non-string entries are rejected', normalizeModelAllowlist([42]).error !== undefined)
check('a valid list carries no error', normalizeModelAllowlist(['claude-*'])?.error === undefined)
check('stored list parses back to entries',
  JSON.stringify(parseModelAllowlist('["gpt-4o","claude-*"]')) === JSON.stringify(['gpt-4o', 'claude-*']))
check('corrupt stored list parses to nothing', parseModelAllowlist('not json').length === 0)
check('missing stored list parses to nothing', parseModelAllowlist(null).length === 0)

check('no group admits everything', modelAllowed('gpt-4o', undefined) === true)
check('disabled gate admits everything', modelAllowed('gpt-4o', groupWith(0, [])) === true)
check('exact entry admits its model', modelAllowed('gpt-4o', groupWith(1, ['gpt-4o'])) === true)
check('exact entry denies another model', modelAllowed('gpt-4o-mini', groupWith(1, ['gpt-4o'])) === false)
check('entry matching is case-insensitive', modelAllowed('GPT-4O', groupWith(1, ['gpt-4o'])) === true)
check('models/ prefix still matches the bare entry',
  modelAllowed('models/gemini-2.5-pro', groupWith(1, ['gemini-2.5-pro'])) === true)
check('-thinking variant matches the base entry',
  modelAllowed('gpt-5-thinking', groupWith(1, ['gpt-5'])) === true)
check('wildcard admits prefixed models', modelAllowed('gpt-4o-turbo', groupWith(1, ['gpt-*'])) === true)
check('wildcard does not admit other families', modelAllowed('claude-3-5', groupWith(1, ['gpt-*'])) === false)
check('enabled with a stored-empty list blocks', modelAllowed('gpt-4o', groupWith(1, [])) === false)
check('an empty model is left to later validation', modelAllowed('', groupWith(1, ['gpt-4o'])) === true)

const denied = await modelAllowlistDenied('gpt-4o-turbo').text()
const deniedBody = JSON.parse(denied)
check('denied model is a 404 with Go wording',
  modelAllowlistDenied('gpt-4o-turbo').status === 404
    && deniedBody.error.code === 'model_not_found'
    && deniedBody.error.message === 'Model "gpt-4o-turbo" does not exist or is not available for this group',
  denied)

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log('  FAIL', failure)
  process.exit(1)
}
