import type { Config } from '../config.js';
import { CanonlintError } from '../util/errors.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { MockProvider } from './mock.js';
import type { LlmProvider } from './types.js';

export type {
  LlmProvider,
  CompletionRequest,
  CompletionResult,
  TokenUsage,
} from './types.js';
export { ZERO_USAGE, addUsage } from './types.js';
export { AnthropicProvider } from './anthropic.js';
export { OllamaProvider } from './ollama.js';
export { MockProvider } from './mock.js';
export * from './untrusted.js';
export * from './pricing.js';

export function createProvider(config: Config): LlmProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'mock':
      return new MockProvider({ model: config.model });
    default: {
      const exhaustive: never = config.provider;
      throw new CanonlintError(`Unknown provider "${String(exhaustive)}".`);
    }
  }
}
