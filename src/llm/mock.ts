import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  TokenUsage,
} from './types.js';

export type MockResponder = (
  request: CompletionRequest,
) => string | Partial<CompletionResult>;

/**
 * Deterministic provider for tests and golden-file fixtures.
 *
 * CI must be able to run the full suite with no API key and no network, so the
 * prompt-shaping and parsing layers are testable without either.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model: string;
  readonly enforcesSchema = false;

  /** Every request this provider has seen, for assertions. */
  readonly calls: CompletionRequest[] = [];

  private readonly responder: MockResponder;

  constructor(options: { model?: string; responder?: MockResponder } = {}) {
    this.model = options.model ?? 'mock-model';
    this.responder = options.responder ?? (() => '{}');
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request);
    const raw = this.responder(request);
    const partial: Partial<CompletionResult> =
      typeof raw === 'string' ? { text: raw } : raw;
    return {
      text: partial.text ?? '',
      usage: partial.usage ?? {
        inputTokens: request.system.length + request.user.length,
        outputTokens: (partial.text ?? '').length,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: partial.model ?? this.model,
      stopReason: partial.stopReason ?? 'end_turn',
      refused: partial.refused ?? false,
    };
  }

  costOf(_usage: TokenUsage): number {
    return 0;
  }
}
