#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCheck } from '../src/commands/check.js';
import { runInit } from '../src/commands/init.js';
import { runIngest } from '../src/commands/ingest.js';
import { loadConfig } from '../src/config.js';
import { createProvider, formatUsd } from '../src/llm/index.js';
import { ZERO_USAGE, addUsage, type TokenUsage } from '../src/llm/types.js';
import { requireProject } from '../src/paths.js';
import { log } from '../src/util/logger.js';
import {
  accumulateCheckReport,
  createEmptyAccumulatedReport,
  markStoryIngested,
  markStorySkipped,
  renderHolmesContinuityMarkdown,
  type HolmesAccumulatedReport,
} from './holmes/accumulateReport.js';
import { loadHolmesManifest, storyTextPath, type HolmesWork } from './holmes/manifest.js';
import { createRetryStats, RetryingProvider, type RetryStats } from './holmes/retryingProvider.js';

const CORPUS_ROOT = process.env.HOLMES_CORPUS_ROOT ?? '/tmp/holmes-corpus';
const LIVE_CWD = process.env.HOLMES_LIVE_CWD ?? '/tmp/canonlint-holmes-live';
const REPORT_PATH = resolve('demo/holmes-continuity-report-live.md');
const STATE_DIR = join(LIVE_CWD, 'state');
const ACCUM_PATH = join(STATE_DIR, 'accumulated-report.json');
const STATS_PATH = join(STATE_DIR, 'stats.json');

/** Hard stop across the whole run, independent of the per-call cfg.maxSpendUsd. */
const TOTAL_BUDGET_USD = Number(process.env.HOLMES_LIVE_BUDGET_USD ?? '40');

/**
 * Cap stories for cheap dry-runs (M3.5 cost control: first 12 ≈ $6).
 * Unset or 0 = full catalog.
 */
const HOLMES_LIMIT = Number(process.env.HOLMES_LIMIT ?? '0');

interface RunStats {
  usage: TokenUsage;
  costUsd: number;
  attempts: number;
  retries: number;
  timeouts: number;
  startedAt: string;
  updatedAt: string;
}

function loadJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function saveJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isStoryDone(acc: HolmesAccumulatedReport, work: HolmesWork): boolean {
  const entry = acc.stories.find((s) => s.work.id === work.id);
  if (!entry) return false;
  if (entry.skipped) return true;
  if (work.order === 1) return entry.ingested;
  return entry.ingested && entry.checked;
}

function writeReport(acc: HolmesAccumulatedReport, stats?: RunStats): void {
  if (stats && acc.meta?.mode === 'live') {
    acc.meta = {
      ...acc.meta,
      costUsd: stats.costUsd,
      date: stats.updatedAt.slice(0, 10),
    };
  }
  mkdirSync(resolve('demo'), { recursive: true });
  writeFileSync(REPORT_PATH, renderHolmesContinuityMarkdown(acc), 'utf8');
}

function checkpoint(acc: HolmesAccumulatedReport, stats: RunStats): void {
  saveJson(ACCUM_PATH, acc);
  saveJson(STATS_PATH, stats);
  writeReport(acc, stats);
}

async function main(): Promise<void> {
  mkdirSync(LIVE_CWD, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });

  const allWorks = loadHolmesManifest(CORPUS_ROOT);
  const works =
    HOLMES_LIMIT > 0 ? allWorks.filter((w) => w.order <= HOLMES_LIMIT) : allWorks;
  if (HOLMES_LIMIT > 0) {
    log.info(
      `HOLMES_LIMIT=${HOLMES_LIMIT}: running first ${works.length} of ${allWorks.length} stories.`,
    );
  }

  const fresh = !existsSync(join(LIVE_CWD, '.canonlint')) || !existsSync(ACCUM_PATH);
  if (fresh) {
    log.info('Fresh run — initializing project and canon DB.');
    mkdirSync(LIVE_CWD, { recursive: true });
    runInit({ cwd: LIVE_CWD, force: true, provider: 'openai-compatible' });
  } else {
    log.info('Resuming from existing checkpoint.');
  }

  const paths = requireProject(LIVE_CWD);
  const cfg = loadConfig(paths, { provider: 'openai-compatible' });
  const realProvider = createProvider(cfg);

  const accumulated =
    loadJson<HolmesAccumulatedReport>(ACCUM_PATH) ??
    createEmptyAccumulatedReport(works, {
      mode: 'live',
      provider: realProvider.name,
      model: realProvider.model,
      date: new Date().toISOString().slice(0, 10),
      costUsd: 0,
    });
  if (!accumulated.meta || accumulated.meta.mode !== 'live') {
    accumulated.meta = {
      mode: 'live',
      provider: realProvider.name,
      model: realProvider.model,
      date: new Date().toISOString().slice(0, 10),
      costUsd: 0,
    };
  }

  const stats: RunStats =
    loadJson<RunStats>(STATS_PATH) ?? {
      usage: ZERO_USAGE,
      costUsd: 0,
      attempts: 0,
      retries: 0,
      timeouts: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

  const retryStats: RetryStats = createRetryStats();
  const llm = new RetryingProvider(realProvider, retryStats, 'venice');

  const remaining = works.filter((w) => !isStoryDone(accumulated, w));
  log.info(
    `${works.length - remaining.length}/${works.length} stories already complete; ` +
      `${remaining.length} remaining.`,
  );

  for (const work of works) {
    if (isStoryDone(accumulated, work)) continue;

    const textPath = storyTextPath(CORPUS_ROOT, work.id);
    if (!existsSync(textPath)) {
      log.warn(`Skipping ${work.title} (${work.id}): missing text at ${textPath}`);
      markStorySkipped(accumulated, work, `missing text at ${textPath}`);
      checkpoint(accumulated, stats);
      continue;
    }

    if (stats.costUsd > TOTAL_BUDGET_USD) {
      log.error(
        `Cumulative spend ${formatUsd(stats.costUsd)} exceeds the run budget ` +
          `${formatUsd(TOTAL_BUDGET_USD)} (HOLMES_LIVE_BUDGET_USD). Stopping before ` +
          `${work.title}. Raise the budget and re-run to resume.`,
      );
      process.exit(1);
    }

    const label = `[${work.order}/${works.length}] ${work.title}`;
    try {
      if (work.order === 1) {
        log.info(`${label} — ingest only`);
        const result = await runIngest({
          path: textPath,
          work: work.title,
          order: work.order,
          cwd: LIVE_CWD,
          llm,
          provider: 'openai-compatible',
        });
        stats.usage = addUsage(stats.usage, result.usage);
        stats.costUsd += result.actualUsd;
        markStoryIngested(accumulated, work);
      } else {
        log.info(`${label} — check + ingest`);
        const report = await runCheck({
          draft: textPath,
          cwd: LIVE_CWD,
          llm,
          provider: 'openai-compatible',
        });
        stats.usage = addUsage(stats.usage, report.usage);
        stats.costUsd += report.actualUsd;
        accumulateCheckReport(accumulated, work, report);
        log.info(
          `  check: ${report.contradictions.length} contradiction(s), ` +
            `${report.timeline.length} timeline, ${report.newFacts.length} new facts, ` +
            `${report.uncertain.length} uncertain (${formatUsd(report.actualUsd)})`,
        );

        const ingestResult = await runIngest({
          path: textPath,
          work: work.title,
          order: work.order,
          cwd: LIVE_CWD,
          llm,
          provider: 'openai-compatible',
        });
        stats.usage = addUsage(stats.usage, ingestResult.usage);
        stats.costUsd += ingestResult.actualUsd;
        markStoryIngested(accumulated, work);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Fatal error on ${label}: ${message}`);
      log.error(
        'Stopping (not skipping) so canon ordering stays intact. Checkpoint is saved; ' +
          're-run this script to resume from this story.',
      );
      stats.updatedAt = new Date().toISOString();
      checkpoint(accumulated, stats);
      process.exitCode = 1;
      return;
    }

    stats.updatedAt = new Date().toISOString();
    checkpoint(accumulated, stats);
    log.info(
      `  cumulative: ${formatUsd(stats.costUsd)} spent, ${retryStats.attempts} call(s), ` +
        `${retryStats.retries} retr${retryStats.retries === 1 ? 'y' : 'ies'}, ` +
        `${retryStats.timeouts} timeout(s)`,
    );
    log.info('');
  }

  log.info('');
  log.info('Holmes live run complete.');
  log.info(`  corpus root     ${CORPUS_ROOT}`);
  log.info(`  live database   ${LIVE_CWD}`);
  log.info(`  stories total   ${accumulated.storiesTotal}`);
  log.info(`  checked         ${accumulated.storiesChecked}`);
  log.info(`  ingested        ${accumulated.storiesIngested}`);
  log.info(`  skipped         ${accumulated.storiesSkipped}`);
  log.info(`  contradictions  ${accumulated.contradictions}`);
  log.info(`  timeline        ${accumulated.timeline}`);
  log.info(`  new facts       ${accumulated.newFacts}`);
  log.info(`  uncertain       ${accumulated.uncertain}`);
  log.info(`  total cost      ${formatUsd(stats.costUsd)}`);
  log.info(`  llm calls       ${retryStats.attempts} (${retryStats.retries} retries)`);
  log.info(`  report          ${REPORT_PATH}`);
  log.info('');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
