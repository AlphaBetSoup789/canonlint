import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import {
  costOfUsage,
  estimateRunCost,
  estimateTokens,
  formatUsd,
  isPriceKnown,
  priceFor,
  FALLBACK_PRICE,
} from '../src/llm/pricing.js';

describe('cost accounting', () => {
  it('prices a plain usage record', () => {
    const usd = costOfUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      { inputPerMTok: 3, outputPerMTok: 15 },
    );
    expect(usd).toBeCloseTo(18, 6);
  });

  it('discounts cache reads and surcharges cache writes', () => {
    const price = { inputPerMTok: 10, outputPerMTok: 0 };
    expect(
      costOfUsage(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 0,
        },
        price,
      ),
    ).toBeCloseTo(1, 6);
    expect(
      costOfUsage(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 1_000_000,
        },
        price,
      ),
    ).toBeCloseTo(12.5, 6);
  });

  it('falls back conservatively for an unknown model', () => {
    expect(priceFor('some-future-model')).toEqual(FALLBACK_PRICE);
    expect(isPriceKnown('some-future-model')).toBe(false);
  });

  it('lets config override the table', () => {
    const config = resolveConfig({ model: 'claude-sonnet-5', priceInputPerMTok: 0 });
    expect(priceFor('claude-sonnet-5', config).inputPerMTok).toBe(0);
    expect(isPriceKnown('anything-at-all', config)).toBe(true);
  });
});

describe('pre-run estimates', () => {
  it('scales with corpus size', () => {
    const config = resolveConfig({ provider: 'anthropic', model: 'claude-sonnet-5' });
    const small = estimateRunCost({ text: 'word '.repeat(1_000), config });
    const large = estimateRunCost({ text: 'word '.repeat(100_000), config });
    expect(large.usd).toBeGreaterThan(small.usd * 50);
    expect(small.priceKnown).toBe(true);
  });

  it('is free on a local provider', () => {
    const config = resolveConfig({ provider: 'ollama' });
    const estimate = estimateRunCost({ text: 'word '.repeat(500_000), config });
    expect(estimate.usd).toBe(0);
  });

  it('flags an unknown price so the CLI can warn', () => {
    const config = resolveConfig({
      provider: 'anthropic',
      model: 'claude-not-yet-released',
    });
    expect(estimateRunCost({ text: 'a b c', config }).priceKnown).toBe(false);
  });

  it('counts tokens in the right ballpark for prose', () => {
    // The full Holmes canon is ~650k words. A heuristic that lands within a
    // factor of two is enough to warn before a large ingest.
    const tokens = estimateTokens('word '.repeat(650_000));
    expect(tokens).toBeGreaterThan(650_000);
    expect(tokens).toBeLessThan(1_300_000);
  });
});

describe('formatting', () => {
  it('never shows $0.00 for a nonzero cost', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.001)).toBe('<$0.01');
    expect(formatUsd(23.456)).toBe('$23.46');
  });
});
