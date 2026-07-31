import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, resolveConfig } from '../src/config.js';
import { createProvider, MockProvider, OllamaProvider } from '../src/llm/index.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';

const ENV_KEYS = [
  'CANONLINT_PROVIDER',
  'CANONLINT_MODEL',
  'CANONLINT_EFFORT',
  'CANONLINT_OLLAMA_URL',
  'CANONLINT_MAX_SPEND_USD',
  'CANONLINT_PRICE_INPUT_PER_MTOK',
  'ANTHROPIC_API_KEY',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('config precedence', () => {
  it('falls back to built-in defaults', () => {
    const config = resolveConfig();
    expect(config.provider).toBe(DEFAULTS.provider);
    expect(config.model).toBe(DEFAULTS.anthropicModel);
    expect(config.maxSpendUsd).toBe(DEFAULTS.maxSpendUsd);
  });

  it('lets the config file override defaults', () => {
    const config = resolveConfig({ model: 'claude-opus-5', maxSpendUsd: 42 });
    expect(config.model).toBe('claude-opus-5');
    expect(config.maxSpendUsd).toBe(42);
  });

  it('lets env override the config file', () => {
    process.env.CANONLINT_MODEL = 'claude-haiku-4-5';
    const config = resolveConfig({ model: 'claude-opus-5' });
    expect(config.model).toBe('claude-haiku-4-5');
  });

  it('lets flags override env', () => {
    process.env.CANONLINT_MODEL = 'claude-haiku-4-5';
    const config = resolveConfig({}, { model: 'claude-sonnet-5' });
    expect(config.model).toBe('claude-sonnet-5');
  });

  it('picks a provider-appropriate default model', () => {
    expect(resolveConfig({ provider: 'ollama' }).model).toBe(DEFAULTS.ollamaModel);
    expect(resolveConfig({ provider: 'anthropic' }).model).toBe(
      DEFAULTS.anthropicModel,
    );
  });

  it('rejects an unknown provider from env', () => {
    process.env.CANONLINT_PROVIDER = 'openai';
    expect(() => resolveConfig()).toThrow(/must be one of/);
  });

  it('rejects an unknown provider from a flag', () => {
    expect(() => resolveConfig({}, { provider: 'gemini' })).toThrow(/must be one of/);
  });

  it('rejects a non-numeric spend cap', () => {
    process.env.CANONLINT_MAX_SPEND_USD = 'lots';
    expect(() => resolveConfig()).toThrow(/must be a number/);
  });

  it('carries price overrides through', () => {
    process.env.CANONLINT_PRICE_INPUT_PER_MTOK = '0.5';
    expect(resolveConfig().priceInputPerMTok).toBe(0.5);
  });

  it('does not hardcode a URL anywhere but config', () => {
    process.env.CANONLINT_OLLAMA_URL = 'http://box.local:9999';
    expect(resolveConfig({ provider: 'ollama' }).ollamaUrl).toBe(
      'http://box.local:9999',
    );
  });
});

describe('provider factory', () => {
  it('builds the provider named by config', () => {
    expect(createProvider(resolveConfig({ provider: 'ollama' }))).toBeInstanceOf(
      OllamaProvider,
    );
    expect(createProvider(resolveConfig({ provider: 'mock' }))).toBeInstanceOf(
      MockProvider,
    );
  });

  it('builds an Anthropic provider without a key present', () => {
    // Credentials may come from an `ant auth login` profile, so constructing
    // the client must not require ANTHROPIC_API_KEY.
    const provider = createProvider(resolveConfig({ provider: 'anthropic' }));
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.model).toBe(DEFAULTS.anthropicModel);
  });
});
