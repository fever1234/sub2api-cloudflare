// Token counting and billing utilities
import { findTokenRate, priceTokens, DEFAULT_RATE } from './pricing';

// Simple token estimation (chars / 4 for English, chars / 2 for CJK)
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // CJK characters
    if ((code >= 0x4E00 && code <= 0x9FFF) || 
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3000 && code <= 0x303F)) {
      tokens += 2;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

// Extract token usage from response headers or body.
//
// `request` is the parsed request body, used only by the estimation fallback:
// a *response* body has no `messages` field, so estimating from it always
// produced zero prompt tokens on an upstream that omits `usage`. Callers pass
// the request only for successful responses — a failed attempt must not bill.
export function extractTokenUsage(
  body: any,
  headers: Headers | Record<string, string>,
  request?: any
): { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens: number } {
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;

  // Try to get from body first.
  //
  // The two spellings disagree about cache reads: Anthropic excludes them from
  // `input_tokens` and reports them as `cache_read_input_tokens`, while OpenAI
  // nests them under `*_details.cached_tokens` and *includes* them in
  // `prompt_tokens`. Net input therefore subtracts only the OpenAI-sourced
  // figure — subtracting the Anthropic one as well would double-count the
  // cache, and never subtracting would leave the two protocols inconsistent.
  if (body?.usage) {
    const usage = body.usage;
    const anthropicCache = Number(usage.cache_read_input_tokens) || 0;
    const openaiCache = Number(usage.prompt_tokens_details?.cached_tokens)
      || Number(usage.input_tokens_details?.cached_tokens)
      || 0;
    cacheReadTokens = anthropicCache || openaiCache;
    const rawPrompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
    promptTokens = Math.max(0, rawPrompt - openaiCache);
    completionTokens = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  }

  // Fallback to estimation
  if (promptTokens + completionTokens + cacheReadTokens === 0 && request !== undefined) {
    const inputSource = request?.messages ?? request?.input ?? request?.content ?? '';
    const inputText = typeof inputSource === 'string' ? inputSource : JSON.stringify(inputSource);
    const outputSource = body?.choices?.[0]?.message?.content ?? body?.output ?? body?.content ?? '';
    const outputText = typeof outputSource === 'string' ? outputSource : JSON.stringify(outputSource);
    promptTokens = estimateTokens(inputText);
    completionTokens = estimateTokens(outputText);
  }

  // Totals are recomputed from the parts rather than trusting the upstream's
  // `total_tokens`: the split rows must add up in the UI, and OpenAI's figure
  // is arithmetically identical anyway (its prompt already included the cache).
  const totalTokens = promptTokens + cacheReadTokens + completionTokens;

  return { promptTokens, completionTokens, totalTokens, cacheReadTokens };
}

/**
 * Reasoning setting a request asked for, stored on its usage row.
 *
 * Providers spell this differently — Chat Completions `reasoning_effort`,
 * Responses `reasoning.effort`, xAI's `reason`, Anthropic's
 * `thinking.budget_tokens` — and none echo it back, so it can only be read
 * from the request. Null means the request did not declare one.
 */
export function extractReasoningEffort(body: any): string | null {
  if (!body || typeof body !== 'object') return null;
  const effort = body.reasoning_effort ?? body.reasoning?.effort ?? body.reason;
  if (effort !== undefined && effort !== null && effort !== '') {
    return String(effort).slice(0, 64);
  }
  const thinking = body.thinking;
  if (thinking && typeof thinking === 'object' && (thinking.type === 'enabled' || thinking.budget_tokens)) {
    return thinking.budget_tokens ? `thinking:${thinking.budget_tokens}` : 'thinking';
  }
  return null;
}

export interface CostBreakdown {
  baseCost: number;
  cost: number;
  multiplier: number;
  estimated: boolean;
}

export function calculateCostBreakdown(provider: string, model: string, promptTokens: number, completionTokens: number, multiplier = 1): CostBreakdown {
  const published = findTokenRate(provider, model);
  const rates = published || DEFAULT_RATE;

  // priceTokens divides by 1,000,000 because the table is per-1M. The previous
  // implementation divided by 1,000 against the same per-1M figures, so every
  // recorded cost — and every quota decrement — was 1000x too large.
  const raw = priceTokens(promptTokens, rates.prompt) + priceTokens(completionTokens, rates.completion);
  const baseCost = round6(raw);
  const safeMultiplier = readMultiplier(multiplier);
  return {
    baseCost,
    cost: round6(baseCost * safeMultiplier),
    multiplier: safeMultiplier,
    estimated: !published
  };
}

/**
 * Coerce a billing weight, falling back to 1x for anything unusable.
 *
 * `null` has to be rejected before the numeric check rather than by it, because
 * `Number(null)` is 0 — a legal weight meaning "free". An account whose
 * rate_multiplier column was never populated would therefore have billed every
 * request at zero and never consumed its key's quota. 0 is still honoured when
 * it is written explicitly, since a genuinely free upstream is a real case.
 */
function readMultiplier(value: unknown): number {
  if (value === null || value === undefined || value === '') return 1;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

/** Six decimals: sub-cent accuracy without accumulating float noise. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// Calculate cost based on model and provider
export function calculateCost(provider: string, model: string, promptTokens: number, completionTokens: number): number {
  return calculateCostBreakdown(provider, model, promptTokens, completionTokens).baseCost;
}
