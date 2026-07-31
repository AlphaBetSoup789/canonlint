import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { CanonlintError } from './util/errors.js';
import type { ProjectPaths } from './paths.js';

/**
 * Configuration precedence, highest first:
 *   1. CLI flags (passed by the command)
 *   2. Environment variables
 *   3. `.canonlint/config.json`
 *   4. Built-in defaults
 *
 * No URL or model name is hardcoded in application logic — everything routes
 * through here.
 */

export const PROVIDERS = ['anthropic', 'ollama', 'mock'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * Defaults live here as data, not scattered through the code.
 *
 * The Anthropic default is a Sherlock-corpus-scale-friendly Sonnet-class model:
 * the M3 cost estimate for the full 60-story canon assumes it. Override with
 * CANONLINT_MODEL for a more capable (and more expensive) run.
 */
export const DEFAULTS = {
  provider: 'anthropic' as ProviderName,
  anthropicModel: 'claude-sonnet-5',
  ollamaModel: 'llama3.1:8b',
  ollamaUrl: 'http://localhost:11434',
  effort: 'medium' as Effort,
  maxTokens: 8192,
  /** Target chunk size in words when splitting a work for extraction. */
  chunkWords: 900,
  /** Guardrail so a stray `ingest` on a huge corpus cannot silently bill. */
  maxSpendUsd: 5,
  /** Claims at or above this confidence are auto-promoted to canon. */
  autoPromoteConfidence: 0.8,
} as const;

const FileConfigSchema = z
  .object({
    provider: z.enum(PROVIDERS).optional(),
    model: z.string().min(1).optional(),
    ollamaUrl: z.string().url().optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
    maxTokens: z.number().int().positive().optional(),
    chunkWords: z.number().int().positive().optional(),
    maxSpendUsd: z.number().nonnegative().optional(),
    autoPromoteConfidence: z.number().min(0).max(1).optional(),
    priceInputPerMTok: z.number().nonnegative().optional(),
    priceOutputPerMTok: z.number().nonnegative().optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

export interface Config {
  provider: ProviderName;
  model: string;
  ollamaUrl: string;
  effort: Effort;
  maxTokens: number;
  chunkWords: number;
  maxSpendUsd: number;
  autoPromoteConfidence: number;
  /** Per-million-token price overrides; undefined falls back to the table. */
  priceInputPerMTok?: number;
  priceOutputPerMTok?: number;
  apiKey?: string;
}

/** Flags a command may pass to override env and file config. */
export interface ConfigOverrides {
  provider?: string;
  model?: string;
  maxSpendUsd?: number;
}

export function readFileConfig(paths: ProjectPaths): FileConfig {
  if (!existsSync(paths.configPath)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configPath, 'utf8'));
  } catch (err) {
    throw new CanonlintError(`${paths.configPath} is not valid JSON.`, {
      cause: err,
    });
  }
  const parsed = FileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new CanonlintError(`Invalid ${paths.configPath}:\n${issues}`);
  }
  return parsed.data;
}

export function writeFileConfig(paths: ProjectPaths, config: FileConfig): void {
  writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CanonlintError(`${name} must be a number, got "${raw}".`);
  }
  return value;
}

function envEnum<T extends string>(name: string, allowed: readonly T[]): T | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!allowed.includes(raw as T)) {
    throw new CanonlintError(
      `${name} must be one of ${allowed.join(', ')} — got "${raw}".`,
    );
  }
  return raw as T;
}

export function resolveConfig(
  fileConfig: FileConfig = {},
  overrides: ConfigOverrides = {},
): Config {
  const overrideProvider = overrides.provider
    ? (() => {
        if (!PROVIDERS.includes(overrides.provider as ProviderName)) {
          throw new CanonlintError(
            `--provider must be one of ${PROVIDERS.join(', ')} — got ` +
              `"${overrides.provider}".`,
          );
        }
        return overrides.provider as ProviderName;
      })()
    : undefined;

  const provider =
    overrideProvider ??
    envEnum('CANONLINT_PROVIDER', PROVIDERS) ??
    fileConfig.provider ??
    DEFAULTS.provider;

  const defaultModel =
    provider === 'ollama' ? DEFAULTS.ollamaModel : DEFAULTS.anthropicModel;

  const config: Config = {
    provider,
    model:
      overrides.model ??
      process.env.CANONLINT_MODEL ??
      fileConfig.model ??
      defaultModel,
    ollamaUrl:
      process.env.CANONLINT_OLLAMA_URL ?? fileConfig.ollamaUrl ?? DEFAULTS.ollamaUrl,
    effort:
      envEnum('CANONLINT_EFFORT', EFFORT_LEVELS) ??
      fileConfig.effort ??
      DEFAULTS.effort,
    maxTokens:
      envNumber('CANONLINT_MAX_TOKENS') ?? fileConfig.maxTokens ?? DEFAULTS.maxTokens,
    chunkWords:
      envNumber('CANONLINT_CHUNK_WORDS') ??
      fileConfig.chunkWords ??
      DEFAULTS.chunkWords,
    maxSpendUsd:
      overrides.maxSpendUsd ??
      envNumber('CANONLINT_MAX_SPEND_USD') ??
      fileConfig.maxSpendUsd ??
      DEFAULTS.maxSpendUsd,
    autoPromoteConfidence:
      envNumber('CANONLINT_AUTO_PROMOTE_CONFIDENCE') ??
      fileConfig.autoPromoteConfidence ??
      DEFAULTS.autoPromoteConfidence,
  };

  const priceIn =
    envNumber('CANONLINT_PRICE_INPUT_PER_MTOK') ?? fileConfig.priceInputPerMTok;
  const priceOut =
    envNumber('CANONLINT_PRICE_OUTPUT_PER_MTOK') ?? fileConfig.priceOutputPerMTok;
  if (priceIn !== undefined) config.priceInputPerMTok = priceIn;
  if (priceOut !== undefined) config.priceOutputPerMTok = priceOut;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) config.apiKey = apiKey;

  return config;
}

export function loadConfig(
  paths: ProjectPaths,
  overrides: ConfigOverrides = {},
): Config {
  return resolveConfig(readFileConfig(paths), overrides);
}
