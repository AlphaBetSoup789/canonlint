import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import { CanonlintError } from '../util/errors.js';
import { costOfUsage, priceFor, type ModelPrice } from './pricing.js';
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  TokenUsage,
} from './types.js';

/**
 * Anthropic adapter.
 *
 * Uses structured outputs (`output_config.format`) so extraction results are
 * schema-valid at the API boundary rather than parsed hopefully afterwards.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly enforcesSchema = true;

  private readonly client: Anthropic;
  private readonly price: ModelPrice;
  private readonly config: Config;

  constructor(config: Config, client?: Anthropic) {
    this.config = config;
    this.model = config.model;
    this.price = priceFor(config.model, config);
    // The SDK resolves credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // or an `ant auth login` profile — so an unset API key is not necessarily
    // an error. Let the SDK decide, and surface its message if it cannot.
    this.client =
      client ?? new Anthropic(config.apiKey ? { apiKey: config.apiKey } : {});
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.config.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      output_config: { effort: this.config.effort },
    };

    if (request.jsonSchema) {
      (params.output_config as Record<string, unknown>).format = {
        type: 'json_schema',
        schema: request.jsonSchema,
      };
    }

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming,
      );
    } catch (err) {
      throw wrapAnthropicError(err, this.model);
    }

    // Check stop_reason before reading content: a refusal returns HTTP 200 with
    // an empty or partial content array.
    if (response.stop_reason === 'refusal') {
      return {
        text: '',
        usage: usageFrom(response),
        model: response.model,
        stopReason: 'refusal',
        refused: true,
      };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      usage: usageFrom(response),
      model: response.model,
      stopReason: response.stop_reason ?? undefined,
    };
  }

  costOf(usage: TokenUsage): number {
    return costOfUsage(usage, this.price);
  }
}

function usageFrom(response: Anthropic.Message): TokenUsage {
  const usage = response.usage;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function wrapAnthropicError(err: unknown, model: string): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new CanonlintError(
      'Anthropic rejected the credentials. Set ANTHROPIC_API_KEY, or run ' +
        '`canonlint --provider ollama ...` to work entirely locally.',
      { cause: err },
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new CanonlintError(
      `Model "${model}" was not found. Set CANONLINT_MODEL to a model your ` +
        'account can reach.',
      { cause: err },
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new CanonlintError(
      'Anthropic rate limit reached. Wait and re-run — ingest is resumable ' +
        'per work.',
      { cause: err },
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
