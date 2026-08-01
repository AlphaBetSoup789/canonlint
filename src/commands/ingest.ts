import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import {
  findClaims,
  findCitedClaims,
  insertClaim,
  insertRun,
  insertSource,
  setClaimStatus,
  updateRunStats,
  upsertWork,
} from '../db/repo.js';
import { createProvider, estimateRunCost, formatUsd } from '../llm/index.js';
import type { LlmProvider, TokenUsage } from '../llm/types.js';
import { ZERO_USAGE, addUsage } from '../llm/types.js';
import { chunkCorpus } from '../ingest/chunk.js';
import { extractClaimsFromChunks } from '../ingest/extract.js';
import { loadCorpus } from '../ingest/load.js';
import { resolveEntity } from '../ingest/resolve.js';
import { requireProject } from '../paths.js';
import { CanonlintError, SpendCapError } from '../util/errors.js';
import { log, style } from '../util/logger.js';

export interface IngestOptions extends ConfigOverrides {
  path: string;
  work?: string;
  order?: number;
  review?: boolean;
  cwd?: string;
  /**
   * Injected LLM for tests / agent-driven acceptance runs.
   * When set, skips `createProvider` and ignores provider name overrides.
   */
  llm?: LlmProvider;
  /** Injected readline for `--review` tests. */
  reviewPrompt?: (question: string) => Promise<string>;
}

export interface IngestResult {
  workTitle: string;
  workId: number;
  runId: number;
  chunks: number;
  claimsInserted: number;
  claimsCanon: number;
  claimsProposed: number;
  claimsRejected: number;
  entitiesTouched: number;
  sourcesInserted: number;
  estimatedUsd: number;
  actualUsd: number;
  usage: TokenUsage;
  warnings: string[];
  model: string;
  provider: string;
}

async function reviewProposedClaims(
  db: Db,
  prompt: (question: string) => Promise<string>,
): Promise<{ promoted: number; rejected: number }> {
  const proposed = findClaims(db, { status: 'proposed' });
  let promoted = 0;
  let rejected = 0;

  for (const claim of proposed) {
    const cited = findCitedClaims(db, { entityId: claim.entity_id }).find(
      (c) => c.id === claim.id,
    );
    const header = cited
      ? `${cited.entity_name}.${cited.attribute} = ${cited.value}`
      : `claim #${claim.id}`;
    const excerpt = cited?.text_excerpt ?? '';
    log.info('');
    log.info(style.bold(header));
    log.detail(`modality=${claim.modality}  confidence=${claim.confidence}`);
    if (cited) {
      log.detail(`${cited.work_title}, ${cited.locator}`);
    }
    if (excerpt) {
      log.detail(`"${excerpt.slice(0, 200)}${excerpt.length > 200 ? '…' : ''}"`);
    }

    const answer = (await prompt('Promote to canon? [y]es / [n]o / [s]kip > '))
      .trim()
      .toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      setClaimStatus(db, claim.id, 'canon');
      promoted += 1;
    } else if (answer === 'n' || answer === 'no') {
      setClaimStatus(db, claim.id, 'rejected');
      rejected += 1;
    }
  }

  return { promoted, rejected };
}

export async function runIngest(options: IngestOptions): Promise<IngestResult> {
  const paths = requireProject(options.cwd);

  const stringOverrides: ConfigOverrides = {};
  if (options.provider) stringOverrides.provider = options.provider;
  if (options.model) stringOverrides.model = options.model;
  if (options.maxSpendUsd !== undefined) {
    stringOverrides.maxSpendUsd = options.maxSpendUsd;
  }

  const cfg = loadConfig(paths, stringOverrides);
  const llm = options.llm ?? createProvider(cfg);

  const corpus = loadCorpus(options.path);
  const workTitle = options.work?.trim() || corpus.defaultTitle;
  if (!workTitle) {
    throw new CanonlintError('Could not determine a work title; pass --work.');
  }

  const estimate = estimateRunCost({ text: corpus.text, config: cfg });
  log.info(
    `Estimated cost ${formatUsd(estimate.usd)} ` +
      `(~${estimate.inputTokens.toLocaleString()} in / ` +
      `~${estimate.outputTokens.toLocaleString()} out on ${estimate.model}` +
      `${estimate.priceKnown ? '' : '; price unknown, using fallback'})`,
  );

  if (estimate.usd > cfg.maxSpendUsd) {
    throw new SpendCapError(estimate.usd, cfg.maxSpendUsd);
  }

  const chunks = chunkCorpus(corpus.files, cfg.chunkWords);
  if (chunks.length === 0) {
    throw new CanonlintError('Nothing to ingest after chunking.');
  }
  log.info(`Chunked into ${chunks.length} segment(s); extracting…`);

  const db = openDb(paths.dbPath, { mustExist: true });
  let reviewRl: ReturnType<typeof createInterface> | undefined;

  try {
    const work = upsertWork(db, {
      title: workTitle,
      order_index: options.order ?? null,
    });

    const run = insertRun(db, {
      kind: 'ingest',
      target: options.path,
      model: llm.model,
      stats: { status: 'running', estimatedUsd: estimate.usd },
    });

    const {
      claims: extracted,
      usage: extractUsage,
      warnings,
    } = await extractClaimsFromChunks(llm, chunks, ({ chunk, index, total }) => {
      log.detail(`[${index + 1}/${total}] ${chunk.label} (${chunk.wordCount} words)`);
    });

    let usage: TokenUsage = extractUsage;
    const entityIds = new Set<number>();
    let sourcesInserted = 0;
    let claimsInserted = 0;
    let claimsCanon = 0;
    let claimsProposed = 0;

    for (const claim of extracted) {
      const resolved = await resolveEntity(db, llm, {
        name: claim.entity_name,
        kind: claim.entity_kind,
        aliases: claim.entity_aliases,
      });
      usage = addUsage(usage, resolved.usage);
      if (!resolved.entity) {
        // Ingest always creates entities; this is defensive.
        throw new CanonlintError(
          `Failed to resolve entity "${claim.entity_name}" during ingest.`,
        );
      }
      entityIds.add(resolved.entity.id);

      const source = insertSource(db, {
        work_id: work.id,
        locator: claim.locator,
        text_excerpt: claim.evidence_quote,
      });
      sourcesInserted += 1;

      const status =
        !options.review && claim.confidence >= cfg.autoPromoteConfidence
          ? 'canon'
          : 'proposed';

      insertClaim(db, {
        entity_id: resolved.entity.id,
        attribute: claim.attribute,
        value: claim.value,
        modality: claim.modality,
        source_id: source.id,
        status,
        confidence: claim.confidence,
        valid_from: claim.valid_from ?? null,
        valid_until: claim.valid_until ?? null,
      });
      claimsInserted += 1;
      if (status === 'canon') claimsCanon += 1;
      else claimsProposed += 1;
    }

    let claimsRejected = 0;
    if (options.review) {
      let prompt = options.reviewPrompt;
      if (!prompt) {
        if (!input.isTTY || !output.isTTY) {
          throw new CanonlintError(
            '`--review` requires an interactive terminal. Omit the flag to ' +
              'auto-promote high-confidence claims, or run from a TTY.',
          );
        }
        reviewRl = createInterface({ input, output });
        prompt = (question: string) => reviewRl!.question(question);
      }
      const reviewed = await reviewProposedClaims(db, prompt);
      claimsCanon += reviewed.promoted;
      claimsProposed -= reviewed.promoted + reviewed.rejected;
      claimsRejected = reviewed.rejected;
    }

    const actualUsd = llm.costOf(usage);
    updateRunStats(db, run.id, {
      status: 'ok',
      chunks: chunks.length,
      claims: claimsInserted,
      claimsCanon,
      claimsProposed: Math.max(0, claimsProposed),
      claimsRejected,
      entities: entityIds.size,
      sources: sourcesInserted,
      estimatedUsd: estimate.usd,
      actualUsd,
      usage,
      warnings,
    });

    for (const warning of warnings) {
      log.warn(warning);
    }

    return {
      workTitle: work.title,
      workId: work.id,
      runId: run.id,
      chunks: chunks.length,
      claimsInserted,
      claimsCanon,
      claimsProposed: Math.max(0, claimsProposed),
      claimsRejected,
      entitiesTouched: entityIds.size,
      sourcesInserted,
      estimatedUsd: estimate.usd,
      actualUsd,
      usage: usage ?? ZERO_USAGE,
      warnings,
      model: llm.model,
      provider: llm.name,
    };
  } finally {
    reviewRl?.close();
    db.close();
  }
}

export function printIngest(result: IngestResult): void {
  log.info('');
  log.success(`Ingested ${style.bold(result.workTitle)}`);
  log.info(
    `  claims     ${result.claimsInserted} ` +
      `(${result.claimsCanon} canon, ${result.claimsProposed} proposed` +
      `${result.claimsRejected ? `, ${result.claimsRejected} rejected` : ''})`,
  );
  log.info(`  entities   ${result.entitiesTouched}`);
  log.info(`  sources    ${result.sourcesInserted}`);
  log.info(`  chunks     ${result.chunks}`);
  log.info(
    `  cost       ${formatUsd(result.actualUsd)} actual ` +
      `(estimated ${formatUsd(result.estimatedUsd)}) via ${result.provider}/${result.model}`,
  );
  log.info('');
  log.detail('canonlint entity <name>   inspect a character or place');
  log.detail('canonlint stats           corpus summary');
}
