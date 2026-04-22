/**
 * Claude model pricing and cost estimation.
 *
 * Rough token-count heuristics — 1 token ≈ 4 characters is the Anthropic
 * rule of thumb for English. Good enough for UI-facing "about $0.02 per
 * request" estimates; the real usage is reported back in the API response.
 * For exact accounting we'd call the count-tokens endpoint, but that's a
 * second network hop per request — not worth the UX cost for a preview.
 *
 * Pricing USD per 1M tokens. Values are approximate and subject to change
 * via the Anthropic pricing page. Review every few months.
 */

interface ModelPricing {
  /** Input tokens per 1M tokens (USD). */
  input: number;
  /** Output tokens per 1M tokens (USD). */
  output: number;
  /** Prompt caching write (first time a prefix is cached). */
  cache_write: number;
  /** Prompt caching read (subsequent requests hitting the cache). */
  cache_read: number;
}

const PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'claude-opus-4-7': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
});

const FALLBACK: ModelPricing = PRICING['claude-sonnet-4-6'];

const pricingFor = (model: string): ModelPricing => {
  if (PRICING[model]) return PRICING[model];
  // Tolerate versioned suffixes that aren't in the map exactly.
  if (model.startsWith('claude-opus-')) return PRICING['claude-opus-4-7'];
  if (model.startsWith('claude-sonnet-')) return PRICING['claude-sonnet-4-6'];
  if (model.startsWith('claude-haiku-')) return PRICING['claude-haiku-4-5-20251001'];
  return FALLBACK;
};

/** Rough char → token conversion. */
export const approxTokensFromChars = (chars: number): number => Math.ceil(chars / 4);

export interface CostEstimate {
  /** USD, rounded to 4 decimals. */
  usd: number;
  /** Formatted for display. */
  display: string;
  /** Heuristic token breakdown used to compute the estimate. */
  input_tokens: number;
  output_tokens: number;
}

/**
 * Estimate cost for a single request. `inputChars` includes system prompt,
 * messages, and any tools; `outputCharsMax` is `max_tokens * 4` as an
 * upper bound. When prompt caching is active, cache hits cost ~10 % of
 * input; we assume a first-cold run (full input price) for the estimate.
 */
export const estimateRequestCost = (
  model: string,
  inputChars: number,
  outputTokenCap: number,
): CostEstimate => {
  const p = pricingFor(model);
  const inputTokens = approxTokensFromChars(inputChars);
  const outputTokens = outputTokenCap;
  const usd = (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  return {
    usd: Math.round(usd * 10_000) / 10_000,
    display: formatUsd(usd),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
};

export const formatUsd = (usd: number): string => {
  if (usd < 0.01) return `< $0.01`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
};

export const modelHasPricing = (model: string): boolean =>
  Object.prototype.hasOwnProperty.call(PRICING, model);
