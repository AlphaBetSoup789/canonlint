import { log } from '../../src/util/logger.js';
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  TokenUsage,
} from '../../src/llm/types.js';

/**
 * Mutable counters shared with the orchestrator so it can report retry
 * volume without the wrapper needing to know about checkpoints or reports.
 */
export interface RetryStats {
  attempts: number;
  retries: number;
  timeouts: number;
}

export function createRetryStats(): RetryStats {
  return { attempts: 0, retries: 0, timeouts: 0 };
}

const MAX_ATTEMPTS = 12;
const PER_CALL_TIMEOUT_MS = 120_000;
const MAX_BACKOFF_MS = 5 * 60_000;

function isTransient(message: string): boolean {
  if (/could not reach/i.test(message)) return true;
  if (/rate limited/i.test(message)) return true;
  if (/^timed out/i.test(message)) return true;
  if (/api error 5\d\d/i.test(message)) return true;
  if (/api error 408/i.test(message)) return true;
  return false;
}

function backoffMs(message: string, attempt: number): number {
  const base = /rate limited/i.test(message) ? 45_000 : 4_000;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(base * Math.pow(1.6, attempt - 1), MAX_BACKOFF_MS) * jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a real LlmProvider so a single flaky Venice call (network blip,
 * 429, 5xx, or a silent hang) is retried with backoff before it ever
 * surfaces to runIngest/runCheck.
 *
 * This matters operationally: runIngest/runCheck are not transactional, so
 * letting a `.complete()` rejection propagate mid-story would leave
 * partially-inserted claims/sources with no clean way to resume that story
 * without duplicating them. Retrying below the command layer means a story
 * only ever fails after MAX_ATTEMPTS truly-exhausted attempts, which the
 * orchestrator treats as fatal (stop, don't skip) rather than something to
 * paper over.
 */
export class RetryingProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly enforcesSchema: boolean;

  constructor(
    private readonly inner: LlmProvider,
    private readonly stats: RetryStats,
    private readonly label = 'venice',
  ) {
    this.name = inner.name;
    this.model = inner.model;
    this.enforcesSchema = inner.enforcesSchema;
  }

  costOf(usage: TokenUsage): number {
    return this.inner.costOf(usage);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.stats.attempts += 1;
      try {
        return await this.raceTimeout(request);
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!isTransient(message) || attempt >= MAX_ATTEMPTS) {
          throw err;
        }
        this.stats.retries += 1;
        const wait = backoffMs(message, attempt);
        log.warn(
          `  [${this.label} retry ${attempt}/${MAX_ATTEMPTS}] ${message.slice(0, 160)} ` +
            `— waiting ${Math.round(wait / 1000)}s`,
        );
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  private async raceTimeout(request: CompletionRequest): Promise<CompletionResult> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.stats.timeouts += 1;
        reject(new Error(`Timed out waiting ${PER_CALL_TIMEOUT_MS}ms for ${this.label}.`));
      }, PER_CALL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.inner.complete(request), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
