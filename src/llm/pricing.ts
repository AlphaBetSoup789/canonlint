import type { Config } from '../config.js';
import type { TokenUsage } from './types.js';

/**
 * Per-million-token prices in USD. This is a data table that goes stale, not
 * program logic — override with CANONLINT_PRICE_INPUT_PER_MTOK /
 * CANONLINT_PRICE_OUTPUT_PER_MTOK (or the same keys in config.json) rather than
 * waiting for a release when prices move.
 *
 * Last checked: 2026-07-31.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },

  // OpenAI-compatible hosts. Prices move faster than releases — override with
  // CANONLINT_PRICE_INPUT_PER_MTOK / _OUTPUT_ rather than waiting for a bump.
  // Venice, last checked 2026-07-31.
  'deepseek-v3.2': { inputPerMTok: 0.33, outputPerMTok: 0.48 },
  'deepseek-v4-pro': { inputPerMTok: 1.65, outputPerMTok: 3.3 },
  'deepseek-v4-flash': { inputPerMTok: 0.138, outputPerMTok: 0.275 },
  'deepseek-v4-flash-0731': { inputPerMTok: 0.072, outputPerMTok: 0.144 },
};

/** Used when a model is not in the table, so estimates stay conservative. */
export const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 5, outputPerMTok: 25 };

export function priceFor(model: string, config?: Config): ModelPrice {
  const base = PRICE_TABLE[model] ?? FALLBACK_PRICE;
  return {
    inputPerMTok: config?.priceInputPerMTok ?? base.inputPerMTok,
    outputPerMTok: config?.priceOutputPerMTok ?? base.outputPerMTok,
  };
}

export function isPriceKnown(model: string, config?: Config): boolean {
  if (config?.priceInputPerMTok !== undefined) return true;
  return model in PRICE_TABLE;
}

export function costOfUsage(usage: TokenUsage, price: ModelPrice): number {
  const input =
    (usage.inputTokens * price.inputPerMTok) / 1_000_000 +
    // Cache reads bill at ~0.1x, writes at ~1.25x.
    (usage.cacheReadTokens * price.inputPerMTok * 0.1) / 1_000_000 +
    (usage.cacheWriteTokens * price.inputPerMTok * 1.25) / 1_000_000;
  const output = (usage.outputTokens * price.outputPerMTok) / 1_000_000;
  return input + output;
}

/**
 * Rough token count for pre-run cost estimates. Deliberately a heuristic and
 * not a tokenizer call: the point is to warn before a large ingest, and the
 * real number is always measured and reported afterwards.
 *
 * ~0.75 words per token for English prose, so ~1.33 tokens per word.
 */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** False when the model is absent from the price table. */
  priceKnown: boolean;
  model: string;
}

/**
 * Estimate a whole run before it starts. `outputRatio` is output tokens
 * expected per input token — extraction produces far less than it reads.
 */
export function estimateRunCost(options: {
  text: string;
  config: Config;
  outputRatio?: number;
}): CostEstimate {
  const { text, config, outputRatio = 0.25 } = options;
  const inputTokens = estimateTokens(text);
  const outputTokens = Math.ceil(inputTokens * outputRatio);
  const price = priceFor(config.model, config);
  const usd =
    config.provider === 'anthropic' || config.provider === 'openai-compatible'
      ? costOfUsage(
          {
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          price,
        )
      : 0;
  return {
    inputTokens,
    outputTokens,
    usd,
    priceKnown:
      (config.provider !== 'anthropic' && config.provider !== 'openai-compatible') ||
      isPriceKnown(config.model, config),
    model: config.model,
  };
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
