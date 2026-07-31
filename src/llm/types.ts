export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic-only; 0 elsewhere. Cheap reads, so tracked separately. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export interface CompletionRequest {
  /** Instructions. Never contains corpus text — see `wrapUntrusted`. */
  system: string;
  /**
   * The turn content. Corpus text belongs here, and only inside a
   * `wrapUntrusted` envelope.
   */
  user: string;
  maxTokens?: number;
  /**
   * JSON Schema the response must satisfy. Providers enforce it natively where
   * they can, and instruct-and-validate where they cannot.
   */
  jsonSchema?: Record<string, unknown>;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  /** The model that actually served the request. */
  model: string;
  stopReason?: string;
  /** True when the provider refused rather than answered. */
  refused?: boolean;
}

/**
 * The one surface every provider implements.
 *
 * Deliberately narrow: canonlint only ever needs "given instructions and a
 * blob of untrusted story text, return structured JSON". Keeping the interface
 * this small is what makes a local Ollama model a first-class option rather
 * than a degraded afterthought.
 */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Whether the provider enforces `jsonSchema` server-side. */
  readonly enforcesSchema: boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** USD cost of a usage record. Local providers return 0. */
  costOf(usage: TokenUsage): number;
}
