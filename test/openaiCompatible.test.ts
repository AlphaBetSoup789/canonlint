import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { OpenAiCompatibleProvider, stripReasoning } from '../src/llm/openaiCompatible.js';
import { createProvider } from '../src/llm/index.js';

const VENICE = 'https://api.venice.ai/api/v1';

function config(overrides: Record<string, unknown> = {}) {
  return resolveConfig({
    provider: 'openai-compatible',
    apiBaseUrl: VENICE,
    ...overrides,
  } as never);
}

/** Capture the outgoing request without touching the network. */
function stubFetch(payload: unknown, status = 200) {
  const spy = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function okResponse(content: string, usage?: Record<string, unknown>) {
  return {
    model: 'deepseek-v3.2',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: usage ?? { prompt_tokens: 100, completion_tokens: 20 },
  };
}

beforeEach(() => {
  process.env.CANONLINT_API_KEY = 'test-key-not-real';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CANONLINT_API_KEY;
});

describe('request shape', () => {
  it('posts OpenAI-shaped chat completions with bearer auth', async () => {
    const spy = stubFetch(okResponse('{}'));
    await new OpenAiCompatibleProvider(config()).complete({
      system: 'sys',
      user: 'usr',
    });

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(`${VENICE}/chat/completions`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key-not-real');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('deepseek-v3.2');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(body.stream).toBe(false);
  });

  it('strips a trailing slash from the configured base URL', async () => {
    const spy = stubFetch(okResponse('{}'));
    await new OpenAiCompatibleProvider(config({ apiBaseUrl: `${VENICE}/` })).complete({
      system: 's',
      user: 'u',
    });
    expect(spy.mock.calls[0]![0]).toBe(`${VENICE}/chat/completions`);
  });

  it('sends the JSON schema as a structured-output request', async () => {
    const spy = stubFetch(okResponse('{}'));
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    await new OpenAiCompatibleProvider(config()).complete({
      system: 's',
      user: 'u',
      jsonSchema: schema,
    });
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema).toEqual(schema);
    expect(body.response_format.json_schema.strict).toBe(true);
  });
});

describe('the two settings that are not cosmetic', () => {
  // Constraint 2: instructions reach the model only from our system prompt.
  // Venice injects its own unless told not to, which would put a third party
  // in the same privileged channel the injection defence depends on.
  it('always disables the host-injected system prompt', async () => {
    const spy = stubFetch(okResponse('{}'));
    await new OpenAiCompatibleProvider(config()).complete({ system: 's', user: 'u' });
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.venice_parameters.include_venice_system_prompt).toBe(false);
  });

  it('asks the host to strip reasoning, and pins temperature to 0', async () => {
    const spy = stubFetch(okResponse('{}'));
    await new OpenAiCompatibleProvider(config()).complete({ system: 's', user: 'u' });
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.venice_parameters.strip_thinking_response).toBe(true);
    expect(body.venice_parameters.disable_thinking).toBe(true);
    expect(body.temperature).toBe(0);
  });
});

describe('reasoning leakage', () => {
  // Observed in production with DeepSeek: <think> blocks land in the message
  // body, and sometimes several complete answers arrive at once. Harmless for
  // prose, fatal for JSON.
  it('removes a think block that the host failed to strip', async () => {
    stubFetch(okResponse('<think>Let me reconsider…</think>{"claims":[]}'));
    const result = await new OpenAiCompatibleProvider(config()).complete({
      system: 's',
      user: 'u',
    });
    expect(result.text).toBe('{"claims":[]}');
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it.each([
    ['<thinking>a</thinking>{"x":1}', '{"x":1}'],
    ['<reasoning>a</reasoning>{"x":1}', '{"x":1}'],
    ['<redacted_reasoning>a</redacted_reasoning>{"x":1}', '{"x":1}'],
    ['{"x":1}', '{"x":1}'],
  ])('strips %s', (input, expected) => {
    expect(stripReasoning(input)).toBe(expected);
  });

  it('handles an unterminated opener rather than leaving a stray tag', () => {
    expect(stripReasoning('{"x":1}<think>never closed')).toBe('{"x":1}');
  });

  it('leaves prose containing the word "think" alone', () => {
    const prose = 'He did not think the fog would lift before morning.';
    expect(stripReasoning(prose)).toBe(prose);
  });
});

describe('usage and cost', () => {
  it('maps OpenAI token fields onto the internal usage shape', async () => {
    stubFetch(
      okResponse('{}', {
        prompt_tokens: 1200,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 800 },
      }),
    );
    const provider = new OpenAiCompatibleProvider(config());
    const result = await provider.complete({ system: 's', user: 'u' });

    expect(result.usage.inputTokens).toBe(1200);
    expect(result.usage.outputTokens).toBe(300);
    expect(result.usage.cacheReadTokens).toBe(800);
    expect(provider.costOf(result.usage)).toBeGreaterThan(0);
  });

  it('prices DeepSeek far below the Anthropic default', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 250_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const deepseek = new OpenAiCompatibleProvider(config()).costOf(usage);
    // $0.33/M in + $0.48/M out => ~$0.45 for a million input tokens.
    expect(deepseek).toBeLessThan(1);
  });
});

describe('failure modes explain themselves', () => {
  it('names the missing base URL', () => {
    expect(() => new OpenAiCompatibleProvider(resolveConfig({ provider: 'openai-compatible' }))).toThrow(
      /CANONLINT_API_BASE_URL/,
    );
  });

  it('names the missing key and offers the local escape hatch', () => {
    delete process.env.CANONLINT_API_KEY;
    expect(() => new OpenAiCompatibleProvider(config())).toThrow(/ollama/);
  });

  it('explains a 401 as a credentials problem', async () => {
    stubFetch({ error: 'unauthorized' }, 401);
    await expect(
      new OpenAiCompatibleProvider(config()).complete({ system: 's', user: 'u' }),
    ).rejects.toThrow(/rejected the credentials/);
  });

  it('explains a 404 as a model or tier problem', async () => {
    stubFetch({ error: 'no such model' }, 404);
    await expect(
      new OpenAiCompatibleProvider(config()).complete({ system: 's', user: 'u' }),
    ).rejects.toThrow(/tier-gated/);
  });

  it('reports a 429 as retryable', async () => {
    stubFetch({ error: 'slow down' }, 429);
    await expect(
      new OpenAiCompatibleProvider(config()).complete({ system: 's', user: 'u' }),
    ).rejects.toThrow(/Rate limited/);
  });
});

describe('factory wiring', () => {
  it('builds the provider named by config', () => {
    expect(createProvider(config())).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it('defaults to deepseek-v3.2 for this provider', () => {
    expect(config().model).toBe('deepseek-v3.2');
  });

  it('still accepts ANTHROPIC_API_KEY so existing setups keep working', () => {
    delete process.env.CANONLINT_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'legacy-key';
    expect(config().apiKey).toBe('legacy-key');
    delete process.env.ANTHROPIC_API_KEY;
  });
});
