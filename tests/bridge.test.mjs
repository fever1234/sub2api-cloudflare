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
await build({
  entryPoints: ['functions/src/utils/responses-bridge.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: outFile, logLevel: 'silent'
})
const bridge = await import(pathToFileURL(outFile).href)
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

// An upstream disconnect with no terminal still finishes the chat stream.
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

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log('  FAIL', failure)
  process.exit(1)
}
