// Structural guards for mistakes that runtime tests cannot catch.
//
// The dropped-write bug (usage records never reaching D1 in production) passed
// every runtime suite because miniflare keeps the process alive after a
// Response, while a real Worker isolate may be destroyed immediately. A test
// that exercises the gateway therefore cannot detect it — only reading the
// source can. Same for icon references: a wrong sprite id renders an empty box
// rather than throwing.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('PASS', name) }
  else { failures.push(`${name} ${detail}`); console.log('FAIL', name, detail) }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

const tsFiles = walk('functions').filter(file => file.endsWith('.ts'))

// ---- 1. every fire-and-forget D1 write must go through defer() -------------
//
// `db.createUsageRecord(...).catch(() => {})` on its own is dropped when the
// isolate dies. It must be either awaited or handed to ctx.waitUntil.
const WRITE_METHODS = [
  'createUsageRecord', 'createRequestLog', 'incrementApiKeyUsage',
  'recordAccountHealthCheck', 'updateAccountError', 'ensureSchema'
]

const strayWrites = []
for (const file of tsFiles) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (!WRITE_METHODS.some(method => line.includes(`.${method}(`))) return
    // Acceptable forms: awaited, deferred, or the method's own definition.
    if (/\bawait\b/.test(line)) return
    if (/\bdefer(All)?\s*\(/.test(line)) return
    if (/^\s*(async\s+)?[a-zA-Z]+\s*\(/.test(line) && line.includes('):')) return
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
    if (/return\s+this\./.test(line)) return
    strayWrites.push(`${file}:${index + 1}`)
  })
}
check('no D1 write is left un-deferred', strayWrites.length === 0, strayWrites.join(' '))

// ---- 2. gateway routes must accept an execution context -------------------
for (const route of ['openai', 'claude', 'gateway']) {
  const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
  const signature = source.match(/export async function handle\w+Request\(([^)]*)\)/)?.[1] || ''
  check(`${route} route receives ctx`, signature.includes('ctx'), signature)
}

// ---- 3. the worker must pass ctx into every route it dispatches -----------
const workerSource = readFileSync('functions/_worker.ts', 'utf8')
const dispatches = [...workerSource.matchAll(/return handle(OpenAI|Claude|Gateway)Request\(([^)]*)\)/g)]
check('worker dispatches at least four gateway routes', dispatches.length >= 4, String(dispatches.length))
const missingCtx = dispatches.filter(match => !match[2].includes('ctx')).map(match => match[1])
check('worker passes ctx to every gateway route', missingCtx.length === 0, missingCtx.join(','))

// ---- 4. every icon reference resolves to a sprite symbol ------------------
const html = readFileSync('frontend/index.html', 'utf8')
const appJs = readFileSync('frontend/app.js', 'utf8')
const symbols = new Set([...html.matchAll(/<symbol[^>]*\bid="([^"]+)"/g)].map(match => match[1]))
check('sprite defines symbols', symbols.size > 0, String(symbols.size))

const referenced = new Set()
for (const match of html.matchAll(/href="#(i-[\w-]+)"/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/href="#\$\{name\}"/g)) void match // built dynamically
for (const match of appJs.matchAll(/icon\(\s*'([^']+)'/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/iconName:\s*'([^']+)'/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/,\s*'(i-[\w-]+)'/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/\[\s*'(i-[\w-]+)'/g)) referenced.add(match[1])
for (const match of appJs.matchAll(/href="#(i-[\w-]+)"/g)) referenced.add(match[1])

const unresolved = [...referenced].filter(name => !symbols.has(name))
check('every referenced icon exists in the sprite', unresolved.length === 0, unresolved.join(' '))

// ---- 5. icon() must not double-prefix ------------------------------------
// Capture to the function's closing brace on its own line: a naive [^}]*
// stops at the '}' inside `${size}` and reads as a false failure.
const iconFn = appJs.match(/function icon\([\s\S]*?\n\}/)?.[0] || ''
check('icon() uses the id verbatim', iconFn.includes('#${name}'), iconFn.replace(/\s+/g, ' '))

// ---- 6. sprite symbols need a viewBox to scale ---------------------------
const symbolTags = [...html.matchAll(/<symbol[^>]*>/g)].map(match => match[0])
const withoutViewBox = symbolTags.filter(tag => !tag.includes('viewBox'))
check('every sprite symbol has a viewBox', withoutViewBox.length === 0, String(withoutViewBox.length))

// ---- 7. the removed channel layer must stay removed ---------------------
const channelLeaks = []
for (const file of [...tsFiles, 'frontend/app.js', 'frontend/index.html']) {
  const source = readFileSync(file, 'utf8')
  // The migration is the one place allowed to reference the retired table.
  // db/schema hold the migration; types.ts documents the retained legacy column.
  if (file.endsWith('db.ts') || file.endsWith('schema.ts') || file.endsWith('types.ts')) continue
  if (/\bchannel_id\b|\/channels\b|listChannels|getChannel\(/.test(source)) {
    channelLeaks.push(file)
  }
}
check('no live code path still uses channels', channelLeaks.length === 0, channelLeaks.join(' '))

// ---- 8. every CSS class emitted by the app must be styled ---------------
const css = readFileSync('frontend/styles.css', 'utf8')
const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1]))
const emitted = new Set()
for (const match of html.matchAll(/class="([^"$]+)"/g)) {
  match[1].split(/\s+/).filter(Boolean).forEach(token => emitted.add(token))
}
for (const match of appJs.matchAll(/class="([^"$]*)"/g)) {
  match[1].split(/\s+/).filter(Boolean).forEach(token => emitted.add(token))
}
// Utility classes applied via classList rather than markup.
for (const extra of ['is-busy', 'hidden', 'active', 'visible', 'dark', 'on', 'open', 'compact']) {
  emitted.add(extra)
}
const unstyled = [...emitted].filter(token => !defined.has(token) && !/^(ico|i-)/.test(token))
check('every emitted class has styling', unstyled.length === 0, unstyled.join(' '))

/** Text of a function body, located by a start marker and a closing line. */
function blockAfter(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  const end = source.indexOf(endMarker, start)
  return end < 0 ? source.slice(start) : source.slice(start, end + endMarker.length)
}

// ---- 8. waitUntil must never be registered from a post-response callback --
// Calling ctx.waitUntil() after the fetch handler returned throws, which the
// runtime surfaces as a 1101 "Worker threw exception". The streaming recorder
// hit exactly that, so the registration must be straight-line code.
{
  const record = readFileSync('functions/src/utils/record.ts', 'utf8')
  const callbackBody = blockAfter(record, 'measureStreamTiming(', ');')
  check('stream recorder does not defer from inside the stream callback',
    !callbackBody.includes('defer(') && !callbackBody.includes('waitUntil'),
    callbackBody.slice(0, 120))
  check('stream recorder registers waitUntil synchronously',
    record.includes('waitUntil?.(persist)') || record.includes('waitUntil(persist)'))
}

// ---- 9. schema work must be gated behind a cheap version check -----------
// Applying the schema is ~30 D1 round trips and Cloudflare caps a request at 50
// subrequests, so an unconditional ensureSchema on a hot path throws 1101.
{
  const db = readFileSync('functions/src/db.ts', 'utf8')
  const body = blockAfter(db, 'async ensureSchema(', 'return !wasReady;')
  check('ensureSchema short-circuits on a version flag',
    body.includes("getSetting('schema_version')"), body.slice(0, 200))
  check('ensureSchema records the version last',
    body.lastIndexOf("setSetting('schema_version'") > body.indexOf('SCHEMA_STATEMENTS'),
    'version must be written after the work')
}


// ---- 10. every settings column a write touches must be declared ----------
// `setSetting` wrote `updated_at` before the column existed. SQLite validates a
// statement at prepare time, so the whole INSERT failed -- and with it every
// flag that marks a migration finished, making the channel fold-in retry on
// every login forever instead of completing once.
{
  const schema = readFileSync('functions/src/schema.ts', 'utf8')
  const db = readFileSync('functions/src/db.ts', 'utf8')

  const createAt = schema.indexOf('CREATE TABLE IF NOT EXISTS settings')
  const settingsBlock = schema.slice(createAt, schema.indexOf('`', createAt))

  const declared = new Set()
  for (const line of settingsBlock.split(/\r?\n/).slice(1)) {
    const name = line.trim().split(/\s+/)[0].replace(/[(),]/g, '')
    if (name && name !== ')') declared.add(name)
  }
  for (const m of schema.matchAll(/table:\s*'settings',\s*column:\s*'(\w+)'/g)) {
    declared.add(m[1])
  }

  // Columns named on the left of an assignment in a settings write.
  const referenced = new Set()
  for (const m of db.matchAll(/settings[^;]{0,240}/g)) {
    for (const col of m[0].matchAll(/SET\s+(\w+)\s*=/g)) referenced.add(col[1])
    for (const col of m[0].matchAll(/,\s*(\w+)\s*=\s*datetime/g)) referenced.add(col[1])
  }

  const missing = [...referenced].filter(col => !declared.has(col))
  check('every settings column a write touches is declared', missing.length === 0,
    `missing=${missing.join(' ')} declared=${[...declared].join(' ')}`)

  // The fallback exists precisely because older databases predate the column.
  check('setSetting degrades when updated_at is absent',
    /DO UPDATE SET value = excluded\.value`/.test(db),
    'a timestamp-free fallback INSERT must remain')
}

// ---- 11. usage records must carry attribution ------------------------------
// Without group_id / account_id the console cannot say which upstream served a
// request, so the usage page degrades to an unfilterable flat list.
{
  const schema = readFileSync('functions/src/schema.ts', 'utf8')
  for (const col of ['group_id', 'account_id', 'ttft_ms']) {
    // A plain substring: the declaration format is fixed, and regex escapes
    // inside a template literal silently collapse (\s becomes s).
    check(`usage_records declares ${col}`,
      schema.includes(`table: 'usage_records', column: '${col}'`))
  }
  const routes = ['openai', 'claude', 'gateway']
  for (const route of routes) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    const call = source.slice(source.indexOf('createUsageRecord'))
    check(`${route} attributes its usage record`,
      /group_id:/.test(call.slice(0, 400)) && /account_id:/.test(call.slice(0, 400)),
      call.slice(0, 90))
  }
  const record = readFileSync('functions/src/utils/record.ts', 'utf8')
  check('streaming recorder attributes its usage record',
    /group_id:\s*context\.groupId/.test(record) && /account_id:\s*context\.accountId/.test(record))
}

// ---- the fetch handler must never let an exception reach the edge ----------
//
// An uncaught throw is what Cloudflare renders as the opaque "Error 1101 Worker
// threw exception" page: the whole site white-screens and the real message is
// only visible in Workers Logs. The router had no guard at all, so one transient
// D1 error on any single route took down the request.
{
  const worker = readFileSync('functions/_worker.ts', 'utf8')
  const handler = worker.slice(worker.indexOf('async fetch('), worker.indexOf('async function route('))
  check('fetch handler wraps routing in try/catch',
    /try\s*\{/.test(handler) && /catch\s*\(/.test(handler),
    handler.slice(0, 120))
  check('fetch handler awaits the router inside the guard',
    /return await route\(/.test(handler))
  check('routing lives in a separate function so the guard covers all of it',
    /async function route\(request: Request, env: Env, ctx: ExecutionContext\)/.test(worker))

  // A `waitUntil` promise that never settles holds the request open until the
  // edge kills it, so the stream bookkeeping needs an upper bound.
  const record = readFileSync('functions/src/utils/record.ts', 'utf8')
  check('streaming bookkeeping bounds its wait',
    /Promise\.race\(/.test(record) && /STREAM_RECORD_TIMEOUT_MS/.test(record))
  check('the bounded promise is the one handed to waitUntil',
    /const persist = settled\.then\(/.test(record))

  // schemaReady() must not report an unreachable database as an empty one.
  const db = readFileSync('functions/src/db.ts', 'utf8')
  const probe = db.slice(db.indexOf('async schemaReady('))
  const probeBody = probe.slice(0, probe.indexOf('\n  }'))
  check('schemaReady does not swallow database errors',
    !/catch/.test(probeBody),
    probeBody.slice(0, 120))
}

// ---- 12. streaming chat must ask the upstream for usage --------------------
// A Chat Completions stream carries a usage frame only when
// stream_options.include_usage is set. A route that forgets to force it bills
// every streamed call at zero tokens — invisible to runtime suites, because
// the stub emits usage unconditionally.
{
  for (const route of ['openai', 'gateway']) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    check(`${route} route forces upstream stream usage`,
      source.includes('ensureChatStreamUsage('))
  }
  // Anthropic reports usage in message_delta regardless, and an OpenAI-only
  // field in its body would be an unknown parameter upstream.
  const claude = readFileSync('functions/src/routes/claude.ts', 'utf8')
  check('claude route does not inject an OpenAI stream field',
    !claude.includes('ensureChatStreamUsage('))
  // The fallback must read the *request*, or it estimates zero prompt tokens.
  const billing = readFileSync('functions/src/billing.ts', 'utf8')
  check('usage estimation falls back to the request body',
    billing.includes('request?.messages'))
}

// ---- 13. hot-path reads must be cached, and writes must invalidate --------
// Every proxied request performs two uncached D1 reads: the API-key lookup and
// the per-account error window. That doubles database traffic on the hot path
// and makes the billing/dashboard database the bottleneck. A stale key cache is
// worse than slow: a revoked key would keep working, so key writes must
// invalidate; a stale *healthy* error window would keep sending traffic to a
// tripped breaker, so recordRequest must drop the cached window on failure.
{
  const auth = readFileSync('functions/src/auth.ts', 'utf8')
  check('auth caches key lookups', auth.includes('apiKeyCache') && auth.includes('API_KEY_CACHE_TTL_MS'))
  check('auth can drop cached keys', auth.includes('invalidateApiKeyCache('))

  const worker = readFileSync('functions/_worker.ts', 'utf8')
  check('key writes invalidate the cache',
    /invalidateApiKeyCache\(\)/.test(worker))
  check('stats endpoint reports cache hit rates',
    worker.includes('auth_cache') && worker.includes('error_stats_cache'))

  const failover = readFileSync('functions/src/failover.ts', 'utf8')
  check('error windows are cached per account', failover.includes('statsCache'))
  check('a failed request drops the cached window',
    /if\s*\(isError\)[^}]*statsCache\.delete/.test(failover.replace(/\n/g, ' ')),
    'recordRequest must delete on isError')

  // The account-model catalogue is a routing input too: caching it onto the
  // account row without dropping the warm snapshot hides it from /v1/models
  // for the rest of the TTL.
  const accountsCfg = readFileSync('functions/src/config/accounts.ts', 'utf8')
  check('catalogue fetch drops the routing snapshot',
    accountsCfg.includes('invalidateAllRoutingSnapshots()'))
  const routingCache = readFileSync('functions/src/utils/routing-cache.ts', 'utf8')
  check('routing cache exposes an all-snapshots invalidation',
    routingCache.includes('export function invalidateAllRoutingSnapshots'))
}

// ---- 14. token-count preflights must never generate ------------------------
// /v1/messages/count_tokens and /v1/responses/input_tokens are advisory
// preflights. A rewrite to the generation path turns a free count into a
// billable completion; forwarding the count endpoint to a provider without it
// yields a 404. Anthropic itself must forward count_tokens (exact counts),
// answer locally only when the endpoint or provider cannot serve it, and never
// write usage, health or rate-limit state for a count.
{
  const claude = readFileSync('functions/src/routes/claude.ts', 'utf8')
  check('claude route detects the count endpoint', claude.includes('isCountTokens'))
  check('claude has a local count fallback', claude.includes('localCountTokensResponse('))
  check('claude forwards count_tokens upstream',
    /isCountTokens\s*\?\s*'\/v1\/messages\/count_tokens'/.test(claude.replace(/\n/g, ' ')))
  const countIdx = claude.indexOf('if (isCountTokens)')
  check('count_tokens answers before health/rate-limit bookkeeping',
    countIdx > -1 && countIdx < claude.indexOf('noteRateLimit('))

  const openai = readFileSync('functions/src/routes/openai.ts', 'utf8')
  check('responses input_tokens is answered locally',
    openai.includes('/responses/input_tokens') && openai.includes("'response.input_tokens'"))
}

// ---- 15. usage rows must carry request-shape telemetry ---------------------
// reasoning_effort and user_agent exist to answer "why was this bill this
// big" and "who sent this". A createUsageRecord call that omits them writes a
// row that cannot answer either, and the omission is invisible at runtime —
// the insert succeeds, it just stores NULL.
{
  const routes = ['openai', 'claude', 'gateway']
  for (const route of routes) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    // Every route-level call is a single defer(...) line; the record.ts
    // recorder is the only multi-line one and is checked below.
    const lines = source.split('\n').filter(line => line.includes('createUsageRecord('))
    check(`${route} passes request-shape telemetry to every usage record`,
      lines.length > 0 && lines.every(line => line.includes('reasoning_effort:') && line.includes('user_agent:')),
      `calls=${lines.length}`)
  }
  const record = readFileSync('functions/src/utils/record.ts', 'utf8')
  check('the stream recorder carries both fields',
    record.includes('reasoning_effort: context.reasoningEffort') && record.includes('user_agent: context.userAgent'))
  const schema = readFileSync('functions/src/schema.ts', 'utf8')
  for (const col of ['reasoning_effort', 'user_agent']) {
    check(`usage_records declares ${col}`,
      schema.includes(`table: 'usage_records', column: '${col}'`))
  }
}

// ---- 16. Responses 400 field-strip retry -----------------------------------
// Relays reject valid Responses bodies for fields their schema does not model
// (max_output_tokens, replayed input[i].status, prompt_cache_breakpoint on a
// non-cache model). Dropping the named field and re-sending once turns a hard
// client 400 into a served request; without the shared budget the same loop
// becomes an amplifier against a hostile upstream.
{
  const compat = readFileSync('functions/src/utils/responses-compat.ts', 'utf8')
  check('compat util exposes the strip transform', compat.includes('export function stripRejectedResponseFields'))
  check('strip retries are bounded', compat.includes('MAX_STRIP_RETRIES = 6'))
  check('retry driver rebuilds a consumed 400 body', compat.includes('export async function sendWithRejectedFieldRetry'))

  for (const route of ['openai', 'gateway']) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    const sendCalls = (source.match(/sendWithRejectedFieldRetry\(/g) || []).length
    check(`${route} strips-and-retries on the main path and in failover`,
      sendCalls >= 2, `calls=${sendCalls}`)
    check(`${route} shares one strip budget across the request`,
      source.includes('createStripRetryState(') && source.includes('stripState?: StripRetryState'))
  }

  const gateway = readFileSync('functions/src/routes/gateway.ts', 'utf8')
  check('gateway leaves Anthropic error shapes alone',
    /provider !== 'anthropic' && upstreamBody !== undefined/.test(gateway.replace(/\n/g, ' ')))
}

// ---- 17. OpenAI silent-refusal detection ------------------------------------
// A long request answered with an empty finish_reason=stop stream must fail
// over instead of being served, and detection is size-gated so short prompts
// that legitimately answer with nothing keep streaming (Go: openai_silent_refusal.go).
{
  const util = readFileSync('functions/src/utils/silent-refusal.ts', 'utf8')
  check('refusal detection is gated at 64KB', util.includes('SILENT_REFUSAL_MIN_BODY_BYTES = 64 * 1024'))
  check('the held buffer fails open past 1MB', util.includes('SILENT_REFUSAL_BUFFER_CAP = 1024 * 1024'))
  check('refusal errors the stream with the failover message',
    util.includes('OpenAI upstream returned an empty completion stream with finish_reason=stop and no usage'))
  check('output is withheld until a positive signal', util.includes('shouldReleaseClientOutput(): boolean'))

  const detectors = {
    openai: [
      "new SilentRefusalDetector(sentBody.length, provider === 'openai')",
      "new SilentRefusalDetector(sendBody?.length ?? 0, currentProvider === 'openai')"
    ],
    gateway: [
      "new SilentRefusalDetector(upstreamBody?.length ?? 0, provider === 'openai')",
      "new SilentRefusalDetector(sendBody?.length ?? 0, provider === 'openai')"
    ]
  }
  for (const route of ['openai', 'gateway']) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    check(`${route} imports the refusal guard`, source.includes("from '../utils/silent-refusal'"))
    const guards = (source.match(/guardSilentRefusalStream\(/g) || []).length
    check(`${route} guards every stream site (main + failover)`, guards >= 4, `guards=${guards}`)
    for (const detector of detectors[route]) {
      check(`${route} arms a detector on the right path`, source.includes(detector))
    }
  }
}

// ---- 18. Group model allowlist ----------------------------------------------
// A key's group may pin which models it can list, retrieve and generate; the
// gate must exist in the schema, the config API, every generation route and
// both model endpoints (Go: group_model_allowlist.go).
{
  const schema = readFileSync('functions/src/schema.ts', 'utf8')
  check('schema version is bumped for the group allowlist columns', schema.includes("SCHEMA_VERSION = '14'"))
  const groupsDdl = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS groups'), schema.indexOf('CREATE TABLE IF NOT EXISTS channels'))
  check('fresh groups table carries the allowlist columns',
    groupsDdl.includes('model_allowlist_enabled INTEGER DEFAULT 0') && groupsDdl.includes('model_allowlist TEXT'))
  check('existing groups tables gain the allowlist columns',
    schema.includes("{ table: 'groups', column: 'model_allowlist_enabled'")
      && schema.includes("{ table: 'groups', column: 'model_allowlist'"))

  const groupsApi = readFileSync('functions/src/config/groups.ts', 'utf8')
  check('groups API normalizes the allowlist', groupsApi.includes('normalizeModelAllowlist('))
  check('groups API rejects an enabled empty allowlist',
    groupsApi.includes('启用模型白名单后至少需要一个模型'))

  for (const route of ['openai', 'gateway', 'claude']) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    check(`${route} imports the allowlist gate`, source.includes("from '../utils/model-allowlist'"))
    check(`${route} denies listed-out models with a 404`,
      source.includes('modelAllowed(model, groups.get(keyGroupId))') && source.includes('modelAllowlistDenied(model)'))
  }

  const worker = readFileSync('functions/_worker.ts', 'utf8')
  check('model list filters by the key\'s group', worker.includes('modelAllowed(entry.id, group)'))
  check('single-model retrieve shares the gate',
    worker.includes('modelAllowlistDenied(id)')
      && /if \(path\.startsWith\('\/v1\/models\/'\) && request\.method === 'GET'\)/.test(worker))
}

// ---- 19. Proactive tool-schema sanitation ---------------------------------
// Go sanitizes tool schemas on the forward paths *before* the first attempt
// (openai_responses_tool_schema.go); a 400 round trip is what the reactive
// strip already covers, so the routes must call the sanitizer pre-send, with
// lookaround removal gated to OpenAI the way Go gates it by platform.
{
  const compat = readFileSync('functions/src/utils/responses-compat.ts', 'utf8')
  check('compat util exports the proactive sanitizer', compat.includes('export function sanitizeToolSchemas('))
  check('lookaround matcher covers lookahead and lookbehind',
    compat.includes(String.raw`/\(\?(?:=|!|<=|<!)/`))
  check('sanitation fails open on a throw', compat.includes('return false;') && compat.includes('catch {'))
  check('instance values are excluded from the schema walk',
    compat.includes('hold instance values, not schemas'))

  for (const route of ['openai', 'gateway', 'claude']) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    check(`${route} imports the proactive sanitizer`, source.includes('sanitizeToolSchemas'))
    const callSite = source.indexOf('sanitizeToolSchemas(')
    const firstSend = source.indexOf('proxyRequest(')
    check(`${route} sanitizes before the first send`,
      callSite > 0 && firstSend > 0 && callSite < firstSend, `sanitize@${callSite} send@${firstSend}`)
  }

  const openai = readFileSync('functions/src/routes/openai.ts', 'utf8')
  const gateway = readFileSync('functions/src/routes/gateway.ts', 'utf8')
  const claude = readFileSync('functions/src/routes/claude.ts', 'utf8')
  check('openai gates lookaround removal on its own provider',
    openai.includes("sanitizeToolSchemas(requestBody, { removeLookaround: provider === 'openai' })"))
  check('gateway gates lookaround removal on its own provider',
    gateway.includes("sanitizeToolSchemas(requestBody, { removeLookaround: provider === 'openai' })"))
  check('gateway re-serializes after a repair', gateway.includes('|| toolSchemaFixed'))
  check('claude repairs without touching patterns',
    claude.includes('sanitizeToolSchemas(requestBody);') && !claude.includes('removeLookaround'))
}

// ---- 20. Input vs cache-read split -----------------------------------------
// `prompt_tokens` records net input on every protocol — OpenAI's cached slice
// is subtracted, Anthropic's is already excluded — and the cache half lands in
// its own column so the two never overlap. The split is recorded everywhere a
// usage row is written, aggregated for the dashboard and never billed.
{
  const schema = readFileSync('functions/src/schema.ts', 'utf8')
  check('schema version is bumped for the cache-read column', schema.includes("SCHEMA_VERSION = '14'"))
  const usageDdl = schema.slice(
    schema.indexOf('CREATE TABLE IF NOT EXISTS usage_records'),
    schema.indexOf('CREATE TABLE IF NOT EXISTS request_logs'))
  check('fresh usage table carries cache_read_tokens', usageDdl.includes('cache_read_tokens INTEGER DEFAULT 0'))
  check('existing usage tables gain the cache column',
    schema.includes("{ table: 'usage_records', column: 'cache_read_tokens'"))

  const billing = readFileSync('functions/src/billing.ts', 'utf8')
  check('extract reads both cache spellings',
    billing.includes('cache_read_input_tokens') && billing.includes('prompt_tokens_details?.cached_tokens'))
  check('extract subtracts only the openai-sourced cache', billing.includes('Math.max(0, rawPrompt - openaiCache)'))

  const db = readFileSync('functions/src/db.ts', 'utf8')
  check('usage insert carries the cache column', db.includes('total_tokens, cache_read_tokens, cost'))
  check('dashboard totals aggregate cache reads', db.includes('SUM(cache_read_tokens), 0) AS cache_read_tokens'))

  const proxy = readFileSync('functions/src/utils/proxy.ts', 'utf8')
  check('stream sniffer reads both cache spellings',
    proxy.includes('"cache_read_input_tokens"') && proxy.includes('"cached_tokens"'))

  for (const route of ['openai', 'gateway', 'claude']) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    const sites = (source.match(/cache_read_tokens:/g) || []).length
    check(`${route} records cache reads on main and failover paths`, sites >= 2, `sites=${sites}`)
  }
  const record = readFileSync('functions/src/utils/record.ts', 'utf8')
  check('streaming records cache reads', record.includes('cache_read_tokens: outcome.cacheReadTokens'))
}

// ---- 21. Account protocol rules + official catalogue fallback --------------
// An opencode_go account may carry its own rule table (Go: credentials.
// protocol_rules). It is validated on write, read on every protocol decision,
// and until an account syncs its catalogue the downstream list answers with
// the official ids (Go: DefaultOpenCodeGoModelIDs) rather than one placeholder.
{
  const schema = readFileSync('functions/src/schema.ts', 'utf8')
  check('schema version is bumped for the protocol-rules column', schema.includes("SCHEMA_VERSION = '14'"))
  const accountsDdl = schema.slice(
    schema.indexOf('export const ACCOUNTS_TABLE_DDL'),
    schema.indexOf('export const SCHEMA_STATEMENTS'))
  check('fresh accounts table carries protocol_rules', accountsDdl.includes('protocol_rules TEXT'))
  check('existing accounts tables gain the column',
    schema.includes("{ table: 'accounts', column: 'protocol_rules'"))

  const sql = readFileSync('functions/schema.sql', 'utf8')
  check('schema.sql carries the column too', sql.includes('protocol_rules TEXT'))

  const types = readFileSync('functions/src/types.ts', 'utf8')
  check('Account type carries the column', types.includes('protocol_rules?: string | null'))

  const accounts = readFileSync('functions/src/config/accounts.ts', 'utf8')
  check('writes validate the rules', accounts.includes('normalizeProtocolRulesInput(body.protocol_rules)'))
  check('writes reject invalid rules with a 400',
    (accounts.match(/normalizeProtocolRulesInput\(/g) || []).length >= 2
    && accounts.includes('jsonError(normalized.error, 400)'))
  check('writes store the normalized JSON', accounts.includes('JSON.stringify(normalized.rules)'))
  check('update clears stored rules on empty input', accounts.includes('updates.protocol_rules = null'))

  const db = readFileSync('functions/src/db.ts', 'utf8')
  check('createAccount inserts the column', db.includes('enabled, rate_multiplier, protocol_rules)'))
  check('updateAccount can write the column', db.includes('if (updates.protocol_rules !== undefined)'))

  // Every protocol decision must read the account, not only the default table.
  const bridge = readFileSync('functions/src/utils/responses-bridge.ts', 'utf8')
  check('bridge exports the account resolver', bridge.includes('export function resolveOpenCodeGoProtocol'))
  check('bridge exports the official catalogue', bridge.includes('export const DEFAULT_OPENCODE_GO_MODEL_IDS'))
  check('bridge validates rules with the Go limits',
    bridge.includes('MAX_PROTOCOL_RULES = 64') && bridge.includes('MAX_PROTOCOL_PATTERN_LENGTH = 128'))
  for (const route of ['openai', 'gateway']) {
    const source = readFileSync(`functions/src/routes/${route}.ts`, 'utf8')
    check(`${route} decides per account`,
      source.includes('resolveOpenCodeGoProtocol(account,') && !source.includes('openCodeGoModelProtocol('))
  }
  const health = readFileSync('functions/src/utils/healthcheck.ts', 'utf8')
  check('probe decides per account', health.includes('resolveOpenCodeGoProtocol(account, probeModel)'))
  check('catalogue labels per account', health.includes('resolveOpenCodeGoProtocol(account, model.id)'))
  check('healthcheck has no default-only decision left', !health.includes('openCodeGoModelProtocol('))

  const worker = readFileSync('functions/_worker.ts', 'utf8')
  check('downstream list falls back to the official catalogue',
    worker.includes('for (const id of DEFAULT_OPENCODE_GO_MODEL_IDS)'))
  check('fallback is skipped once a catalogue is cached', worker.includes('if (!readCachedModels(account))'))
  check('downstream labels per account', worker.includes('resolveOpenCodeGoProtocol(account, id)'))

  const frontend = readFileSync('frontend/app.js', 'utf8')
  check('account dialog offers the rules field', frontend.includes("textareaInput('protocol_rules'"))
  check('cleared field is sent back to clear storage',
    frontend.includes("else if (editing) payload.protocol_rules = ''"))
}

console.log()
console.log(`PASSED ${pass} / ${pass + failures.length}`)
for (const failure of failures) console.log(' -', failure)
process.exit(failures.length ? 1 : 0)
