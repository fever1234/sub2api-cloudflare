// OpenCode Go usage refresh + stream-outcome observability.
//
// The eligibility, due-calculation and payload-parsing rules ported from Go's
// opencode_go_usage.go decide *whether* an official fetch may fire and *when*
// it may fire again — a mistake here either polls the official endpoint on
// every request or never shows quota at all. The stream-outcome side is
// asserted against measureStreamTiming itself: the outcome tags are what an
// operator sees when debugging "the stream died", so each settle path (close,
// upstream error, client cancel, idle stall, total ceiling) must report the
// tag that points at the right culprit.
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

const outDir = mkdtempSync(join(tmpdir(), 'sub2api-usage-'))
const usageFile = join(outDir, 'usage.mjs')
const proxyFile = join(outDir, 'proxy.mjs')
await build({
  entryPoints: ['functions/src/utils/usage-refresh.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: usageFile, logLevel: 'silent'
})
await build({
  entryPoints: ['functions/src/utils/proxy.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: proxyFile, logLevel: 'silent'
})
const usage = await import(pathToFileURL(usageFile).href)
const proxy = await import(pathToFileURL(proxyFile).href)
rmSync(outDir, { recursive: true, force: true })

const {
  OPENCODE_USAGE_DEFAULT_URL,
  OPENCODE_USAGE_INTERVAL_MS,
  OPENCODE_USAGE_MANUAL_MIN_GAP_MS,
  isOpenCodeGoBaseUrl,
  isOpenCodeGoUsageAccount,
  isUsageRefreshDue,
  isManualRefreshRateLimited,
  parseOpenCodeGoUsageJson,
  readUsageSnapshot,
  usageStateFromAccount,
} = usage
const { measureStreamTiming } = proxy

// ---- endpoint constants (Go: opencode.go.* defaults) -----------------------
check('default endpoint is the official /zen/go/v1/usage URL',
  OPENCODE_USAGE_DEFAULT_URL === 'https://opencode.ai/zen/go/v1/usage', OPENCODE_USAGE_DEFAULT_URL)
check('refresh interval is 15 minutes', OPENCODE_USAGE_INTERVAL_MS === 15 * 60 * 1000)
check('manual refresh gap is 30 seconds', OPENCODE_USAGE_MANUAL_MIN_GAP_MS === 30 * 1000)

// ---- official base-url match (Go: isOpenCodeGoBaseURL) ---------------------
const goodUrls = [
  'https://opencode.ai/zen/go/v1',
  'https://opencode.ai/zen/go',
  'https://opencode.ai/zen/go/',
  'https://opencode.ai/zen/go/v1/',
  'https://opencode.ai:443/zen/go/v1',
  'https://OpenCode.AI/zen/go/v1',
]
for (const url of goodUrls) check(`official base_url accepted: ${url}`, isOpenCodeGoBaseUrl(url) === true)

const badUrls = [
  'http://opencode.ai/zen/go/v1',          // not https
  'https://opencode.ai/v1',                 // wrong path
  'https://opencode.ai/zen',                // wrong path
  'https://opencode.ai/zen/go/v2',          // wrong path
  'https://opencode.ai/zen/go/v1?x=1',      // query string
  'https://opencode.ai/zen/go/v1#frag',     // fragment
  'https://opencode.ai:8443/zen/go/v1',     // non-default port
  'https://api.opencode.ai/zen/go/v1',      // wrong host
  'https://opencode.ai.evil.com/zen/go/v1', // suffix trick
  'https://user@opencode.ai/zen/go/v1',     // userinfo
  'ftp://opencode.ai/zen/go/v1',            // wrong scheme
  '',
  'not-a-url',
]
for (const url of badUrls) check(`base_url rejected: ${url || '(empty)'}`, isOpenCodeGoBaseUrl(url) === false)

// ---- account eligibility ---------------------------------------------------
check('opencode_go account is eligible (plan assumed)',
  isOpenCodeGoUsageAccount({ provider: 'opencode_go', api_key: 'sk-x', base_url: '' }) === true)
check('opencode_go without key is not eligible',
  isOpenCodeGoUsageAccount({ provider: 'opencode_go', api_key: '  ' }) === false)
check('openai + official base_url is eligible',
  isOpenCodeGoUsageAccount({ provider: 'openai', api_key: 'k', base_url: 'https://opencode.ai/zen/go/v1' }) === true)
check('anthropic + official base_url is eligible',
  isOpenCodeGoUsageAccount({ provider: 'anthropic', api_key: 'k', base_url: 'https://opencode.ai/zen/go' }) === true)
check('openai + its own API host is not eligible',
  isOpenCodeGoUsageAccount({ provider: 'openai', api_key: 'k', base_url: 'https://api.openai.com/v1' }) === false)
check('xai on the official host stays excluded (not a Go mount platform)',
  isOpenCodeGoUsageAccount({ provider: 'xai', api_key: 'k', base_url: 'https://opencode.ai/zen/go/v1' }) === false)
check('unknown provider is not eligible',
  isOpenCodeGoUsageAccount({ provider: 'grok', api_key: 'k', base_url: 'https://opencode.ai/zen/go/v1' }) === false)
check('missing account is not eligible', isOpenCodeGoUsageAccount(null) === false)

// ---- due calculation -------------------------------------------------------
const now = Date.parse('2026-09-28T12:00:00.000Z')
const okSnapshot = fetchedAt => ({
  status: 'ok',
  data: { rolling: { status: 'ok', percent: 12.5, resets_at: null }, weekly: { status: 'ok', percent: 5, resets_at: null }, monthly: { status: 'ok', percent: 1, resets_at: null } },
  fetched_at: fetchedAt,
  last_attempt_at: fetchedAt,
  next_refresh_at: new Date(Date.parse(fetchedAt) + OPENCODE_USAGE_INTERVAL_MS).toISOString(),
})
check('missing snapshot is due (first fetch)', isUsageRefreshDue(null, now) === true)
check('fresh ok snapshot is not due', isUsageRefreshDue(okSnapshot(new Date(now - 60_000).toISOString()), now) === false)
check('ok snapshot past the interval is due',
  isUsageRefreshDue(okSnapshot(new Date(now - OPENCODE_USAGE_INTERVAL_MS - 1000).toISOString()), now) === true)
check('ok snapshot at exactly the interval is due',
  isUsageRefreshDue(okSnapshot(new Date(now - OPENCODE_USAGE_INTERVAL_MS).toISOString()), now) === true)
check('unreadable fetched_at fails open to a refetch',
  isUsageRefreshDue({ status: 'ok', fetched_at: 'not-a-date', last_attempt_at: 'x' }, now) === true)
const failedBefore = { status: 'failed', last_attempt_at: new Date(now - 5000).toISOString(), next_refresh_at: new Date(now + 60_000).toISOString(), failure_count: 1 }
const failedAfter = { ...failedBefore, next_refresh_at: new Date(now - 1000).toISOString() }
check('failed snapshot waits for its backoff', isUsageRefreshDue(failedBefore, now) === false)
check('failed snapshot retries once backoff elapses', isUsageRefreshDue(failedAfter, now) === true)
check('failed snapshot without next_refresh_at fails open',
  isUsageRefreshDue({ status: 'failed', last_attempt_at: 'x' }, now) === true)

// ---- manual rate limit -----------------------------------------------------
check('manual refresh blocked inside the 30s gap',
  isManualRefreshRateLimited({ status: 'ok', last_attempt_at: new Date(now - 10_000).toISOString(), next_refresh_at: 'x' }, now) === true)
check('manual refresh allowed after the 30s gap',
  isManualRefreshRateLimited({ status: 'ok', last_attempt_at: new Date(now - 31_000).toISOString(), next_refresh_at: 'x' }, now) === false)
check('manual refresh allowed with no history',
  isManualRefreshRateLimited(null, now) === false)

// ---- payload parse (Go: parseOpenCodeGoUsageJSON) --------------------------
const wrapped = JSON.stringify({
  usage: {
    rolling: { status: 'ok', percent: 12.5, resetsAt: '2026-09-28T16:00:00Z' },
    weekly: { status: 'exhausted', percent: 100, resetsAt: '2026-10-01T00:00:00Z' },
    monthly: { status: 'ok', percent: 42, resetsAt: '2026-10-15T00:00:00Z' },
  },
})
const parsedWrapped = parseOpenCodeGoUsageJson(wrapped)
check('wrapped {usage:{...}} payload parses', parsedWrapped !== null)
check('rolling percent parsed', parsedWrapped?.rolling?.percent === 12.5, JSON.stringify(parsedWrapped?.rolling))
check('resetsAt camelCase becomes resets_at ISO', parsedWrapped?.rolling?.resets_at === '2026-09-28T16:00:00.000Z', String(parsedWrapped?.rolling?.resets_at))
check('status carried through', parsedWrapped?.weekly?.status === 'exhausted')

const direct = JSON.stringify({ rolling: { status: 'ok', percent: 3, resets_at: '2026-09-29T00:00:00Z' } })
const parsedDirect = parseOpenCodeGoUsageJson(direct)
check('direct (unwrapped) payload parses', parsedDirect?.rolling?.percent === 3)
check('missing windows degrade to zero values',
  parsedDirect?.weekly !== undefined && parsedDirect?.weekly.percent === 0 && parsedDirect?.weekly.status === '')

check('invalid JSON is rejected', parseOpenCodeGoUsageJson('<html>404</html>') === null)
check('scalar JSON is rejected', parseOpenCodeGoUsageJson('42') === null)
check('array JSON is rejected', parseOpenCodeGoUsageJson('[1,2]') === null)
const badReset = parseOpenCodeGoUsageJson(JSON.stringify({ rolling: { status: 'ok', percent: 1, resetsAt: 'garbage' } }))
check('unparseable reset degrades to null', badReset?.rolling?.resets_at === null)

// ---- snapshot read + state DTO ---------------------------------------------
check('unreadable snapshot text reads as null', readUsageSnapshot({ usage_snapshot: '{broken' }) === null)
check('missing snapshot reads as null', readUsageSnapshot({}) === null)
const goodSnap = okSnapshot(new Date(now).toISOString())
check('valid snapshot round-trips', readUsageSnapshot({ usage_snapshot: JSON.stringify(goodSnap) })?.status === 'ok')
const state = usageStateFromAccount({ id: 7, provider: 'opencode_go', api_key: 'k', usage_snapshot: JSON.stringify(goodSnap) })
check('state DTO carries account id', state.account_id === 7)
check('state DTO carries eligibility', state.eligible === true)
check('state DTO carries the snapshot', state.snapshot?.status === 'ok')
check('state DTO for a foreign account is ineligible',
  usageStateFromAccount({ id: 8, provider: 'xai', api_key: 'k' }).eligible === false)

// ---- stream outcomes (measureStreamTiming) ---------------------------------
function bytes(text) { return new TextEncoder().encode(text) }
async function collect(stream) {
  const reader = stream.getReader()
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}
function outcomeOf(guard, source, startedAt = Date.now()) {
  let captured
  const measured = measureStreamTiming(source, startedAt, outcome => { captured = outcome }, guard, false)
  return { measured, done: () => captured }
}

{ // completed: clean close after chunks.
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes('data: one\n\n'))
      controller.enqueue(bytes('data: two\n\n'))
      controller.close()
    }
  })
  const { measured, done } = outcomeOf(undefined, source)
  const chunks = await collect(measured)
  check('completed stream forwards every chunk', chunks.length === 2)
  const outcome = done()
  check('clean close reports completed', outcome?.outcome === 'completed', String(outcome?.outcome))
  check('completed stream measured ttft', typeof outcome?.ttftMs === 'number' && outcome.ttftMs >= 0)
  check('completed stream measured total', typeof outcome?.totalMs === 'number' && outcome.totalMs >= 0)
}

{ // upstream_error: source fails mid-stream.
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes('data: partial\n\n'))
      controller.error(new Error('upstream reset'))
    }
  })
  const { measured, done } = outcomeOf(undefined, source)
  let rejected = false
  try { await collect(measured) } catch { rejected = true }
  check('upstream error propagates to the reader', rejected)
  const outcome = done()
  check('source failure reports upstream_error', outcome?.outcome === 'upstream_error', String(outcome?.outcome))
}

{ // client_abort: consumer cancels mid-stream.
  const source = new ReadableStream({
    start(controller) { controller.enqueue(bytes('data: first\n\n')) }
  })
  const { measured, done } = outcomeOf(undefined, source)
  const reader = measured.getReader()
  await reader.read()
  await reader.cancel()
  const outcome = done()
  check('client cancel reports client_abort', outcome?.outcome === 'client_abort', String(outcome?.outcome))
}

{ // stalled: guard idle window fires while the source says nothing.
  const source = new ReadableStream({
    start(controller) { controller.enqueue(bytes('data: first\n\n')) }
  })
  const { measured, done } = outcomeOf({ idleTimeoutMs: 60, totalTimeoutMs: 5000, keepaliveIntervalMs: 0 }, source)
  let rejected = false
  try { await collect(measured) } catch { rejected = true }
  check('idle stream is failed by the guard', rejected)
  const outcome = done()
  check('idle window reports stalled', outcome?.outcome === 'stalled', String(outcome?.outcome))
}

{ // timeout: total ceiling fires while data keeps flowing.
  let keepPumping = true
  const source = new ReadableStream({
    pull(controller) {
      return new Promise(resolve => setTimeout(() => {
        if (!keepPumping) return resolve()
        try { controller.enqueue(bytes('data: tick\n\n')) } catch { return resolve() }
        resolve()
      }, 10))
    }
  })
  const { measured, done } = outcomeOf({ idleTimeoutMs: 5000, totalTimeoutMs: 80, keepaliveIntervalMs: 0 }, source)
  let rejected = false
  try { await collect(measured) } catch { rejected = true }
  keepPumping = false
  const outcome = done()
  check('total ceiling fails a never-ending stream', rejected)
  check('total ceiling reports timeout', outcome?.outcome === 'timeout', String(outcome?.outcome))
}

// ---- summary ----------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
