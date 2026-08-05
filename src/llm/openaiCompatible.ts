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
 * Adapter for any service that speaks the OpenAI chat-completions shape.
 *
 * Deliberately generic rather than a `venice.ts`: the same code reaches Venice,
 * OpenRouter, Together, Groq, DeepInfra, vLLM, LM Studio, and llama.cpp's
 * server. For an OSS writing tool that is a large adoption difference for no
 * extra work — the user points `CANONLINT_API_BASE_URL` wherever they like.
 *
 * Two behaviours here are not cosmetic:
 *
 * 1. **Venice injects its own system prompt unless told not to.** This tool's
 *    entire injection defence rests on the claim that instructions reach the
 *    model only from our system prompt. A third party writing into that same
 *    channel falsifies it, so `include_venice_system_prompt` is forced off.
 *    The flag is ignored by every non-Venice host, so it is safe to always send.
 *
 * 2. **Reasoning models leak their thinking into the message body.** DeepSeek
 *    in particular emits `<think>` blocks, and sometimes several complete
 *    answers in one response. That is survivable for prose and fatal for JSON.
 *    We ask the host to strip it, and defensively strip it again ourselves.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  readonly model: string;
  readonly enforcesSchema = true;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly price: ModelPrice;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.model = config.model;
    this.price = priceFor(config.model, config);
    this.baseUrl = (config.apiBaseUrl ?? '').replace(/\/+$/, '');

    if (!this.baseUrl) {
      throw new CanonlintError(
        'No API base URL configured. Set CANONLINT_API_BASE_URL (for Venice: ' +
          'https://api.venice.ai/api/v1) or add "apiBaseUrl" to ' +
          '.canonlint/config.json.',
      );
    }
    if (!config.apiKey) {
      throw new CanonlintError(
        'No API key configured. Set CANONLINT_API_KEY for this provider, or ' +
          'use `--provider ollama` to run entirely locally.',
      );
    }
    this.apiKey = config.apiKey;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      max_tokens: request.maxTokens ?? this.config.maxTokens,
      // Extraction must be reproducible: the same passage has to yield the
      // same claims. Hosts default to 0.7–0.8, which is wrong for this task.
      temperature: 0,
      stream: false,
      venice_parameters: {
        include_venice_system_prompt: false,
        strip_thinking_response: true,
        disable_thinking: true,
      },
    };

    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'canonlint_response',
          strict: true,
          schema: request.jsonSchema,
        },
      };
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new CanonlintError(
        `Could not reach ${this.baseUrl}. Check CANONLINT_API_BASE_URL and your network.`,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw await describeHttpError(response, this.model, this.baseUrl);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const choice = payload.choices?.[0];
    const usage = payload.usage;

    return {
      text: stripReasoning(choice?.message?.content ?? ''),
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
      model: payload.model ?? this.model,
      stopReason: choice?.finish_reason ?? undefined,
      refused: choice?.finish_reason === 'content_filter',
    };
  }

  costOf(usage: TokenUsage): number {
    return costOfUsage(usage, this.price);
  }
}

/**
 * Remove reasoning blocks a host failed to strip.
 *
 * Belt and braces on top of `strip_thinking_response`: not every OpenAI-shaped
 * host honours it, and a single leaked `<think>` turns valid JSON into a parse
 * error at the worst possible moment — mid-ingest, hundreds of chunks in.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<redacted_reasoning>[\s\S]*?<\/redacted_reasoning>/gi, '')
    // Unterminated opener: the model started thinking and never closed the tag.
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .replace(/<\/?(?:think|thinking|reasoning|redacted_reasoning)>/gi, '')
    .trim();
}

async function describeHttpError(
  response: Response,
  model: string,
  baseUrl: string,
): Promise<CanonlintError> {
  const detail = (await response.text().catch(() => '')).slice(0, 400);

  if (response.status === 401 || response.status === 403) {
    return new CanonlintError(
      `The API rejected the credentials (${response.status}). Check ` +
        `CANONLINT_API_KEY is set and valid for ${baseUrl}.`,
    );
  }
  if (response.status === 404) {
    return new CanonlintError(
      `Model "${model}" was not found at ${baseUrl} (404). Check ` +
        'CANONLINT_MODEL, and that your plan includes it — some models are ' +
        'tier-gated.',
    );
  }
  if (response.status === 429) {
    return new CanonlintError(
      'Rate limited. Wait and re-run — ingest is resumable per work.',
    );
  }
  return new CanonlintError(`API error ${response.status}: ${detail}`);
}

interface ChatCompletionResponse {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: { role: string; content: string | null };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}
