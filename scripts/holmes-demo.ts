#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCheck } from '../src/commands/check.js';
import { runInit } from '../src/commands/init.js';
import { runIngest } from '../src/commands/ingest.js';
import { log } from '../src/util/logger.js';
import {
  accumulateCheckReport,
  createEmptyAccumulatedReport,
  markStoryIngested,
  markStorySkipped,
  renderHolmesContinuityMarkdown,
} from './holmes/accumulateReport.js';
import {
  loadHolmesManifest,
  loadStoryClaims,
  storyClaimsPath,
  storyTextPath,
} from './holmes/manifest.js';
import { mockHolmesProvider } from './holmes/mockHolmesProvider.js';

const CORPUS_ROOT = process.env.HOLMES_CORPUS_ROOT ?? '/tmp/holmes-corpus';
const DEMO_CWD = process.env.HOLMES_DEMO_CWD ?? '/tmp/canonlint-holmes-demo';
const STRICT = process.env.HOLMES_STRICT === '1';
const REPORT_PATH = resolve('demo/holmes-continuity-report.md');

function resetDemoProject(): void {
  const projectDir = join(DEMO_CWD, '.canonlint');
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  mkdirSync(DEMO_CWD, { recursive: true });
  runInit({ cwd: DEMO_CWD, force: true, provider: 'mock' });
}

function failOrWarn(message: string): void {
  if (STRICT) {
    throw new Error(message);
  }
  log.warn(message);
}

async function main(): Promise<void> {
  const works = loadHolmesManifest(CORPUS_ROOT);
  resetDemoProject();

  const accumulated = createEmptyAccumulatedReport(works);

  for (const work of works) {
    const textPath = storyTextPath(CORPUS_ROOT, work.id);
    const claimsPath = storyClaimsPath(CORPUS_ROOT, work.id);

    if (!existsSync(textPath)) {
      const reason = `missing text at ${textPath}`;
      failOrWarn(`Skipping ${work.title} (${work.id}): ${reason}`);
      if (STRICT) break;
      markStorySkipped(accumulated, work, reason);
      continue;
    }

    if (!existsSync(claimsPath)) {
      const reason = `missing claims at ${claimsPath}`;
      failOrWarn(`Skipping ${work.title} (${work.id}): ${reason}`);
      if (STRICT) break;
      markStorySkipped(accumulated, work, reason);
      continue;
    }

    const storyClaims = loadStoryClaims(claimsPath);
    const llm = mockHolmesProvider(storyClaims);

    if (work.order === 1) {
      log.info(`[${work.order}/${works.length}] ingest only — ${work.title}`);
      await runIngest({
        path: textPath,
        work: work.title,
        order: work.order,
        cwd: DEMO_CWD,
        llm,
        provider: 'mock',
      });
      markStoryIngested(accumulated, work);
      continue;
    }

    log.info(`[${work.order}/${works.length}] check + ingest — ${work.title}`);
    const report = await runCheck({
      draft: textPath,
      cwd: DEMO_CWD,
      llm,
      provider: 'mock',
    });
    accumulateCheckReport(accumulated, work, report);

    await runIngest({
      path: textPath,
      work: work.title,
      order: work.order,
      cwd: DEMO_CWD,
      llm,
      provider: 'mock',
    });
    markStoryIngested(accumulated, work);
  }

  mkdirSync(resolve('demo'), { recursive: true });
  writeFileSync(REPORT_PATH, renderHolmesContinuityMarkdown(accumulated), 'utf8');

  log.info('');
  log.info('Holmes demo summary');
  log.info(`  corpus root     ${CORPUS_ROOT}`);
  log.info(`  demo database   ${DEMO_CWD}`);
  log.info(`  stories total   ${accumulated.storiesTotal}`);
  log.info(`  checked         ${accumulated.storiesChecked}`);
  log.info(`  ingested        ${accumulated.storiesIngested}`);
  log.info(`  skipped         ${accumulated.storiesSkipped}`);
  log.info(`  contradictions  ${accumulated.contradictions}`);
  log.info(`  timeline        ${accumulated.timeline}`);
  log.info(`  new facts       ${accumulated.newFacts}`);
  log.info(`  uncertain       ${accumulated.uncertain}`);
  log.info(`  report          ${REPORT_PATH}`);
  log.info('');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
