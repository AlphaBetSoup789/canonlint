import type { Config } from '../config.js';
import { CanonlintError } from '../util/errors.js';
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  TokenUsage,
} from './types.js';

/**
 * Ollama adapter — a first-class v1 provider, not an afterthought.
 *
 * The largest potential user base for this tool is hobbyist and indie writers.
 * "Get a paid API key before you can try it" kills that adoption, so `ingest`
 * and `check` must both run with zero cloud spend against a local model.
 * Quality is lower; the README says so plainly rather than hiding it.
 */
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly model: string;
  readonly enforcesSchema = true; // Ollama's `format` accepts a JSON Schema.

  private readonly baseUrl: string;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.model = config.model;
    this.baseUrl = config.ollamaUrl.replace(/\/+$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      stream: false,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      options: {
        num_predict: request.maxTokens ?? this.config.maxTokens,
        // Ollama defaults num_ctx to 2048 regardless of what the model
        // supports. A ~900-word chunk plus the system prompt and schema
        // overflows that, and Ollama truncates silently rather than erroring —
        // which reads as a weak prompt when it is actually a config bug.
        num_ctx: this.config.numCtx,
        // Extraction must be reproducible. Ollama's default is 0.8.
        temperature: 0,
      },
    };
    if (request.jsonSchema) {
      body.format = request.jsonSchema;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new CanonlintError(
        `Could not reach Ollama at ${this.baseUrl}. Is it running? ` +
          `(\`ollama serve\`, then \`ollama pull ${this.model}\`)`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 404) {
        throw new CanonlintError(
          `Ollama does not have the model "${this.model}". ` +
            `Run \`ollama pull ${this.model}\`.`,
        );
      }
      throw new CanonlintError(
        `Ollama returned ${response.status}: ${detail.slice(0, 400)}`,
      );
    }

    const payload = (await response.json()) as OllamaChatResponse;

    return {
      text: payload.message?.content ?? '',
      usage: {
        inputTokens: payload.prompt_eval_count ?? 0,
        outputTokens: payload.eval_count ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: payload.model ?? this.model,
      stopReason: payload.done_reason ?? undefined,
    };
  }

  /** Local inference costs nothing but electricity. */
  costOf(_usage: TokenUsage): number {
    return 0;
  }
}

interface OllamaChatResponse {
  model?: string;
  message?: { role: string; content: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}
