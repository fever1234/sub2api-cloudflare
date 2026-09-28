// Billing arithmetic, checked against the published per-1M price tables.
//
// This suite exists because a unit mismatch here is invisible everywhere else:
// the table stored USD per 1,000,000 tokens while the calculation divided by
// 1,000, so every recorded cost — and every API-key quota decrement — was 1000x
// too large. Nothing in the gateway or UI suites noticed, because they only
// assert that *a* cost was written, not that it is the right number.
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

// The modules are TypeScript, so they are bundled to a temp ESM file rather
// than duplicating the rate table into the test — a copied table would drift
// from the real one and then assert against itself.
const outDir = mkdtempSync(join(tmpdir(), 'sub2api-pricing-'))
const outFile = join(outDir, 'billing.mjs')
await build({
  entryPoints: ['functions/src/billing.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: outFile, logLevel: 'silent'
})
const { calculateCostBreakdown, calculateCost, extractTokenUsage, extractReasoningEffort } = await import(pathToFileURL(outFile).href)

// ---- the unit itself --------------------------------------------------------
// gpt-5.5 publishes $5 per 1M input and $30 per 1M output. 1,000,000 input
// tokens must therefore cost exactly $5, not $5,000.
const million = calculateCostBreakdown('openai', 'gpt-5.5', 1_000_000, 0)
check('1M input tokens cost the published per-1M price', million.cost === 5, million.cost)

const millionOut = calculateCostBreakdown('openai', 'gpt-5.5', 0, 1_000_000)
check('1M output tokens cost the published per-1M price', millionOut.cost === 30, millionOut.cost)

// A realistic small call. 1000 in + 500 out at gpt-5.5 = 0.005 + 0.015.
const small = calculateCostBreakdown('openai', 'gpt-5.5', 1000, 500)
check('a small call costs cents, not thousands', Math.abs(small.cost - 0.02) < 1e-9, small.cost)
check('a small call is not flagged as estimated', small.estimated === false, small.estimated)

// ---- longest-prefix matching ------------------------------------------------
// gpt-5.5-pro is 6x the price of gpt-5.5; resolving it to the shorter prefix
// would undercharge every request to the most expensive model in the catalogue.
const pro = calculateCostBreakdown('openai', 'gpt-5.5-pro', 1_000_000, 0)
check('gpt-5.5-pro does not fall back to the gpt-5.5 rate', pro.cost === 30, pro.cost)

const dated = calculateCostBreakdown('openai', 'gpt-5.6-sol-2026-03-09', 1_000_000, 0)
check('a dated model id resolves to its family rate', dated.cost === 4, dated.cost)
check('a dated model id is not an estimate', dated.estimated === false, dated.estimated)

const opus = calculateCostBreakdown('anthropic', 'claude-opus-5-20260214', 1_000_000, 0)
check('a dated claude id resolves to its family rate', opus.cost === 5, opus.cost)

const opus48 = calculateCostBreakdown('anthropic', 'claude-opus-4-8', 1_000_000, 0)
check('claude-opus-4.8 is priced', opus48.cost === 5 && opus48.estimated === false, opus48)

const opus48Dotted = calculateCostBreakdown('anthropic', 'claude-opus-4.8', 1_000_000, 0)
check('the dotted claude spelling resolves too',
  opus48Dotted.cost === 5 && opus48Dotted.estimated === false, opus48Dotted)

// ---- unknown models --------------------------------------------------------
// An unknown model must still cost something. Billing it at 0 would let it
// consume an unlimited quota without ever tripping a key's spend cap.
const unknown = calculateCostBreakdown('openai', 'some-unreleased-model', 1_000_000, 1_000_000)
check('an unknown model still bills', unknown.cost > 0, unknown.cost)
check('an unknown model is flagged as estimated', unknown.estimated === true, unknown.estimated)

const noModel = calculateCostBreakdown('openai', '', 1000, 1000)
check('a missing model name does not throw', Number.isFinite(noModel.cost), noModel.cost)

// xAI publishes no rates here, so every grok model is an estimate rather than
// silently reusing OpenAI's numbers.
const grok = calculateCostBreakdown('xai', 'grok-2-latest', 1000, 1000)
check('xai models are estimated, not priced as openai', grok.estimated === true, grok.estimated)

// ---- multipliers -----------------------------------------------------------
// The multiplier is the account's billing weight. base_cost must stay the
// published price so the dashboard can show what produced the charged figure.
const halved = calculateCostBreakdown('openai', 'gpt-5.5', 1_000_000, 0, 0.5)
check('a multiplier scales the charged cost', halved.cost === 2.5, halved.cost)
check('a multiplier leaves the base cost alone', halved.baseCost === 5, halved.baseCost)
check('the multiplier is reported', halved.multiplier === 0.5, halved.multiplier)

const doubled = calculateCostBreakdown('openai', 'gpt-5.5', 1_000_000, 0, 2)
check('a multiplier above 1 charges more', doubled.cost === 10, doubled.cost)

const freeAccount = calculateCostBreakdown('openai', 'gpt-5.5', 1_000_000, 0, 0)
check('a zero multiplier means free', freeAccount.cost === 0, freeAccount.cost)
check('a zero multiplier keeps the base price visible', freeAccount.baseCost === 5, freeAccount.baseCost)

// A corrupt multiplier must not silently zero out billing or produce NaN, which
// would poison every downstream sum on the dashboard.
for (const bad of [NaN, -1, undefined, null, 'abc']) {
  const guarded = calculateCostBreakdown('openai', 'gpt-5.5', 1_000_000, 0, bad)
  check(`multiplier ${String(bad)} falls back to 1x`,
    guarded.multiplier === 1 && guarded.cost === 5, `${guarded.multiplier} / ${guarded.cost}`)
}

// ---- negative and absent token counts --------------------------------------
const negative = calculateCostBreakdown('openai', 'gpt-5.5', -100, -100)
check('negative token counts cost nothing', negative.cost === 0, negative.cost)

// ---- the legacy helper agrees with the breakdown ---------------------------
// Both are called from different routes; if they disagree, the same request
// costs a different amount depending on which path served it.
check('calculateCost matches the breakdown base cost',
  calculateCost('openai', 'gpt-5.5', 1000, 500) === small.baseCost,
  `${calculateCost('openai', 'gpt-5.5', 1000, 500)} vs ${small.baseCost}`)

// ---- provider token shapes -------------------------------------------------
// Anthropic reports input_tokens/output_tokens. Reading only OpenAI's field
// names undercharged every Claude request through the generic gateway.
const anthropicUsage = extractTokenUsage({ usage: { input_tokens: 9, output_tokens: 4 } }, {})
check('anthropic token fields are read',
  anthropicUsage.promptTokens === 9 && anthropicUsage.completionTokens === 4, anthropicUsage)
check('anthropic total is derived', anthropicUsage.totalTokens === 13, anthropicUsage.totalTokens)

const openaiUsage = extractTokenUsage({ usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }, {})
check('openai token fields are read',
  openaiUsage.promptTokens === 11 && openaiUsage.totalTokens === 16, openaiUsage)

// ---- input vs cache reads are recorded separately --------------------------
// OpenAI folds cached tokens into prompt_tokens; Anthropic excludes its cache
// reads from input_tokens. Net input must mean the same thing on both, and the
// cache half is recorded — but never billed (pricing has no cache rate).
const openaiCached = extractTokenUsage({
  usage: { prompt_tokens: 1200, completion_tokens: 50, total_tokens: 1250, prompt_tokens_details: { cached_tokens: 200 } }
}, {})
check('openai cached tokens are split out of input',
  openaiCached.promptTokens === 1000 && openaiCached.cacheReadTokens === 200, openaiCached)
check('openai total keeps the cache', openaiCached.totalTokens === 1250, openaiCached.totalTokens)

const responsesCached = extractTokenUsage({
  usage: { input_tokens: 500, output_tokens: 10, input_tokens_details: { cached_tokens: 100 } }
}, {})
check('responses-shaped cached tokens are split out',
  responsesCached.promptTokens === 400 && responsesCached.cacheReadTokens === 100, responsesCached)

const anthropicCached = extractTokenUsage({
  usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 700 }
}, {})
check('anthropic cache reads are read as-is (already excluded from input)',
  anthropicCached.promptTokens === 300 && anthropicCached.cacheReadTokens === 700, anthropicCached)
check('anthropic total includes cache reads', anthropicCached.totalTokens === 1040, anthropicCached.totalTokens)

const uncached = extractTokenUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, {})
check('rows without cache report zero cache reads',
  uncached.cacheReadTokens === 0 && uncached.promptTokens === 10 && uncached.totalTokens === 15, uncached)

// ---- estimation fallback ---------------------------------------------------
// An upstream that strips `usage` must still bill something — but the prompt
// lives on the *request*: a response body has no `messages` field, so the old
// fallback estimated two junk tokens from `""` and undercharged every one.
const estimated = extractTokenUsage({}, {}, { messages: [{ role: 'user', content: 'hello world, this is a prompt' }] })
check('usage-less responses fall back to a prompt estimate',
  estimated.promptTokens > 0 && estimated.totalTokens >= estimated.promptTokens, estimated)

const withContent = extractTokenUsage(
  { choices: [{ message: { content: 'and here is the completion text' } }] },
  {},
  { messages: [{ role: 'user', content: 'hello' }] }
)
check('completion tokens are estimated from the response content',
  withContent.completionTokens > 0 && withContent.promptTokens > 0, withContent)

// A failed attempt carries an error envelope, not an answer; billing it would
// charge the caller for upstream work that never happened.
check('a response without a request body bills nothing',
  extractTokenUsage({}, {}).totalTokens === 0)

// ---- the scheduling-side multiplier ----------------------------------------
// accountRateMultiplier reads the same column but feeds account selection as
// well as billing, so a null there is worse than a mispriced row: 0 sorts as
// the cheapest upstream and would win every request.
const proxyFile = join(outDir, 'proxy.mjs')
await build({
  entryPoints: ['functions/src/utils/proxy.ts'],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: proxyFile, logLevel: 'silent'
})
const { accountRateMultiplier, ensureChatStreamUsage } = await import(pathToFileURL(proxyFile).href)

check('a stored multiplier is used', accountRateMultiplier({ rate_multiplier: 0.5 }) === 0.5)
check('an explicit free upstream stays free', accountRateMultiplier({ rate_multiplier: 0 }) === 0)
for (const bad of [null, undefined, '', NaN, -1, 'abc']) {
  check(`account multiplier ${String(bad)} falls back to 1x`,
    accountRateMultiplier({ rate_multiplier: bad }) === 1,
    String(accountRateMultiplier({ rate_multiplier: bad })))
}
check('a missing column falls back to 1x', accountRateMultiplier({}) === 1)
check('a missing account falls back to 1x', accountRateMultiplier(null) === 1)

// ---- stream usage injection ------------------------------------------------
// A streaming Chat Completions response carries a usage frame only when
// stream_options.include_usage is set. Without it every streamed call — the
// default for chat clients — is billed at zero tokens.
const streamBody = { model: 'gpt-4o', stream: true }
check('include_usage is injected for a streaming chat body',
  ensureChatStreamUsage(streamBody) === true && streamBody.stream_options?.include_usage === true, streamBody)

const explicitOn = { stream_options: { include_usage: true } }
check('an explicit include_usage is left alone',
  ensureChatStreamUsage(explicitOn) === false && explicitOn.stream_options.include_usage === true)

const explicitOff = { stream_options: { include_usage: false, foo: 1 } }
check('an explicit false is overridden, sibling fields survive',
  ensureChatStreamUsage(explicitOff) === true
    && explicitOff.stream_options.include_usage === true
    && explicitOff.stream_options.foo === 1, explicitOff)

const plainOptions = { stream_options: { temperature: 0 } }
check('a missing include_usage is added beside existing options',
  ensureChatStreamUsage(plainOptions) === true && plainOptions.stream_options.temperature === 0, plainOptions)

check('a non-object body is untouched', ensureChatStreamUsage(null) === false && ensureChatStreamUsage('{"a":1}') === false)

// ---- reasoning-effort telemetry --------------------------------------------
// None of the providers echo the reasoning setting back, so a usage row can
// only carry it when the request declared one — and each provider spells it
// differently.
check('chat-completions reasoning_effort is read',
  extractReasoningEffort({ reasoning_effort: 'high' }) === 'high')
check('responses reasoning.effort is read',
  extractReasoningEffort({ reasoning: { effort: 'low' } }) === 'low')
check("xai's reason field is read", extractReasoningEffort({ reason: 'auto' }) === 'auto')
check('anthropic thinking budgets are recorded',
  extractReasoningEffort({ thinking: { type: 'enabled', budget_tokens: 2048 } }) === 'thinking:2048')
check('anthropic thinking without a budget is still recorded',
  extractReasoningEffort({ thinking: { type: 'enabled' } }) === 'thinking')
check('a request that declares no reasoning yields null',
  extractReasoningEffort({ messages: [{ role: 'user', content: 'hi' }] }) === null)
check('a missing body yields null', extractReasoningEffort(null) === null && extractReasoningEffort(undefined) === null)
check('a non-object body yields null', extractReasoningEffort('reasoning_effort') === null)
const longEffort = extractReasoningEffort({ reasoning_effort: 'x'.repeat(200) })
check('an absurd effort string is bounded', longEffort.length === 64, longEffort.length)

rmSync(outDir, { recursive: true, force: true })

console.log()
console.log(`PASSED ${pass} / ${pass + failures.length}`)
if (failures.length) {
  console.log('FAILURES:')
  failures.forEach(entry => console.log('  -', entry))
  process.exit(1)
}
