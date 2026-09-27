// x-opencode-session resolution + UA spoofing (opencode-session.ts).
//
// This suite exists because the session id is invisible until upstream prompt
// cache stops hitting: a per-request random UUID looks perfectly healthy while
// silently forcing every turn to pay full input tokens. The rules are also a
// port of sub2api's openai_opencode_session.go / openai_content_session_seed.go,
// so both the fallback order and the content-seed semantics are asserted
// against the module itself.
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

const outDir = mkdtempSync(join(tmpdir(), 'sub2api-session-'))
const outFile = join(outDir, 'session.mjs')
await build({
  entryPoints: ['functions/src/utils/opencode-session.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: outFile, logLevel: 'silent'
})
const mod = await import(pathToFileURL(outFile).href)
rmSync(outDir, { recursive: true, force: true })

const { resolveOpenCodeSessionId, deriveContentSessionSeed, applyOpenCodeHeaders } = mod

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const chatTurn = (extra = {}) => ({
  model: 'muse-spark-1.3',
  messages: [
    { role: 'system', content: 'You are a helpful agent.' },
    { role: 'user', content: 'Fix the failing test' },
  ],
  ...extra,
})
const grownConversation = (extra = {}) => ({
  model: 'muse-spark-1.3',
  messages: [
    { role: 'system', content: 'You are a helpful agent.' },
    { role: 'user', content: 'Fix the failing test' },
    { role: 'assistant', content: 'Running the suite now.' },
    { role: 'user', content: 'Still red.' },
  ],
  ...extra,
})

// ---- explicit session headers (sub2api's priority list) --------------------
check('x-opencode-session client header wins',
  resolveOpenCodeSessionId({ clientHeaders: { 'x-opencode-session': 'sess-h' }, body: chatTurn() }) === 'sess-h')
for (const name of ['session-id', 'session_id', 'conversation_id', 'x-session-affinity', 'x-session-id', 'x-conversation-id', 'x-claude-code-session-id']) {
  check(`explicit header ${name} is honored`,
    resolveOpenCodeSessionId({ clientHeaders: { [name]: `v-${name}` }, body: chatTurn() }) === `v-${name}`)
}
check('header match is case-insensitive for record headers',
  resolveOpenCodeSessionId({ clientHeaders: { 'Session-Id': 'Case-OK' }, body: chatTurn() }) === 'Case-OK')
check('Headers instance client headers are read',
  resolveOpenCodeSessionId({ clientHeaders: new Headers({ 'x-session-id': 'from-headers' }), body: chatTurn() }) === 'from-headers')
check('explicit header beats prompt_cache_key',
  resolveOpenCodeSessionId({ clientHeaders: { 'x-session-id': 'h' }, body: chatTurn({ prompt_cache_key: 'b' }) }) === 'h')
check('control characters are stripped',
  resolveOpenCodeSessionId({ clientHeaders: { 'x-opencode-session': 'ab\u0000c\u001fd' }, body: null }) === 'abcd')

// ---- body fields -----------------------------------------------------------
check('prompt_cache_key is used when no header is sent',
  resolveOpenCodeSessionId({ body: chatTurn({ prompt_cache_key: 'cache-key-1' }) }) === 'cache-key-1')
check('metadata.user_id is used when no header/cache key is sent',
  resolveOpenCodeSessionId({ body: chatTurn({ metadata: { user_id: 'meta-1' } }) }) === 'meta-1')
check('metadata.user_id JSON session_id is unwrapped',
  resolveOpenCodeSessionId({ body: chatTurn({ metadata: { user_id: JSON.stringify({ session_id: 'nested-1' }) } }) }) === 'nested-1')
check('already-applied session header is reused instead of minting',
  resolveOpenCodeSessionId({ body: chatTurn(), appliedHeaders: { 'x-opencode-session': 'applied-1' } }) === 'applied-1')
check('header beats body, body beats applied',
  resolveOpenCodeSessionId({
    clientHeaders: { 'session-id': 'h' },
    body: chatTurn({ prompt_cache_key: 'b' }),
    appliedHeaders: { 'x-opencode-session': 'a' },
  }) === 'h')

// ---- content-derived seed (the prompt-cache fix) ---------------------------
const seedTurn1 = resolveOpenCodeSessionId({ body: chatTurn() })
const seedTurn2 = resolveOpenCodeSessionId({ body: grownConversation() })
check('no-signal body yields a compat_cs_ seed instead of a UUID',
  seedTurn1.startsWith('compat_cs_') && !UUID_RE.test(seedTurn1), seedTurn1)
check('same conversation keeps one session across turns', seedTurn1 === seedTurn2, `${seedTurn1} vs ${seedTurn2}`)
check('same conversation is deterministic across calls',
  resolveOpenCodeSessionId({ body: grownConversation() }) === seedTurn2)
check('seed fits the 256-char header budget', seedTurn1.length <= 256 && seedTurn1.length > 10, String(seedTurn1.length))
check('different opening message yields a different session',
  resolveOpenCodeSessionId({ body: chatTurn({ messages: [{ role: 'user', content: 'Write a parser' }] }) }) !== seedTurn1)
check('different system prefix yields a different session',
  resolveOpenCodeSessionId({
    body: { model: 'muse-spark-1.3', messages: [{ role: 'system', content: 'Different rules.' }, { role: 'user', content: 'Fix the failing test' }] },
  }) !== seedTurn1)
check('a system message after the first user turn does not change the session',
  resolveOpenCodeSessionId({
    body: {
      model: 'muse-spark-1.3',
      messages: [
        { role: 'system', content: 'You are a helpful agent.' },
        { role: 'user', content: 'Fix the failing test' },
        { role: 'assistant', content: 'ok' },
        { role: 'system', content: 'late system' },
        { role: 'user', content: 'again' },
      ],
    },
  }) === seedTurn1)
check('different model yields a different session',
  resolveOpenCodeSessionId({ body: { ...chatTurn(), model: 'grok-4.7' } }) !== seedTurn1)
check('different tool definitions yield a different session',
  resolveOpenCodeSessionId({ body: chatTurn({ tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }] }) }) !== seedTurn1)
check('same conversation with same tools stays stable',
  resolveOpenCodeSessionId({ body: { ...chatTurn({ tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }] }) } })
    === resolveOpenCodeSessionId({ body: { ...grownConversation({ tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }] }) } }))
check('JSON whitespace does not change the session',
  resolveOpenCodeSessionId({ body: JSON.parse(JSON.stringify(chatTurn()).replace(/,/g, ', ')) }) === seedTurn1)
check('indented JSON does not change the session',
  resolveOpenCodeSessionId({ body: JSON.parse(JSON.stringify(chatTurn(), null, 2)) }) === seedTurn1)
check('seed still applies when UUID generation is forbidden',
  resolveOpenCodeSessionId({ body: chatTurn(), allowGenerate: false }) === seedTurn1)
check('model-only body still seeds (sub2api ModelOnly semantics)',
  resolveOpenCodeSessionId({ body: { model: 'gpt-5.4' } }).startsWith('compat_cs_'))

// ---- responses API bodies --------------------------------------------------
const respTurn1 = { model: 'gpt-5.6-luna', input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Rules.' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }] }
const respTurn2 = { ...respTurn1, input: [...respTurn1.input, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'More' }] }] }
check('responses input seed is stable across turns',
  resolveOpenCodeSessionId({ body: respTurn1 }) === resolveOpenCodeSessionId({ body: respTurn2 })
  && resolveOpenCodeSessionId({ body: respTurn1 }).startsWith('compat_cs_'))
check('responses input_text fallback captures the first user turn',
  resolveOpenCodeSessionId({ body: { model: 'gpt-5.6-luna', input: [{ type: 'input_text', text: 'Only text' }] } })
    !== resolveOpenCodeSessionId({ body: { model: 'gpt-5.6-luna', input: [{ type: 'input_text', text: 'Other text' }] } }))
check('responses string input seeds from the string',
  resolveOpenCodeSessionId({ body: { model: 'gpt-5.6-luna', input: 'Ping' } }) === deriveContentSessionSeed({ model: 'gpt-5.6-luna', input: 'Ping' })
  && deriveContentSessionSeed({ model: 'gpt-5.6-luna', input: 'Ping' }).startsWith('compat_cs_'))

// ---- UUID fallback only for empty bodies -----------------------------------
const generated = resolveOpenCodeSessionId({ body: null, allowGenerate: true })
check('empty body with allowGenerate mints a UUID', UUID_RE.test(generated), generated)
check('empty body without allowGenerate resolves to empty', resolveOpenCodeSessionId({ body: {}, allowGenerate: false }) === '')
check('two empty-body probes get distinct UUIDs',
  resolveOpenCodeSessionId({ body: null, allowGenerate: true }) !== generated)

// ---- applyOpenCodeHeaders end to end --------------------------------------
{
  const headers = { 'content-type': 'application/json', authorization: 'Bearer x' }
  applyOpenCodeHeaders(headers, { body: chatTurn(), clientHeaders: {}, allowGenerate: true })
  check('headers get the derived session', headers['x-opencode-session'] === seedTurn1, headers['x-opencode-session'])
  check('default UA is the opencode agent', headers['user-agent'] === 'opencode/1.0.0', headers['user-agent'])
}
{
  const headers = { 'user-agent': 'CustomAgent/9.9' }
  applyOpenCodeHeaders(headers, { body: chatTurn() })
  check('operator-configured UA keeps the final say', headers['user-agent'] === 'CustomAgent/9.9')
}
{
  const headers = { 'x-opencode-session': 'pre-set' }
  applyOpenCodeHeaders(headers, { body: chatTurn() })
  check('pre-applied session is preserved', headers['x-opencode-session'] === 'pre-set')
}
{
  const headers = { 'X-Opencode-Session': 'legacy-cased' }
  applyOpenCodeHeaders(headers, { body: chatTurn() })
  check('existing session key is replaced without duplicates',
    headers['x-opencode-session'] === 'legacy-cased' && !('X-Opencode-Session' in headers) && Object.keys(headers).filter((k) => k.toLowerCase() === 'x-opencode-session').length === 1,
    JSON.stringify(headers))
}
{
  const headers = {}
  applyOpenCodeHeaders(headers, { clientHeaders: { 'x-session-id': 'explicit' }, body: chatTurn(), allowGenerate: true })
  check('explicit client session flows through apply', headers['x-opencode-session'] === 'explicit')
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log('FAILED:', f)
  process.exit(1)
}
