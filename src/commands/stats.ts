import { relative } from 'node:path';
import { openDb } from '../db/index.js';
import { getStats } from '../db/repo.js';
import type { DbStats } from '../db/types.js';
import { LATEST_SCHEMA_VERSION } from '../db/index.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { requireProject } from '../paths.js';
import { log, style } from '../util/logger.js';

export interface StatsOptions extends ConfigOverrides {
  cwd?: string;
  json?: boolean;
}

export interface StatsResult extends DbStats {
  dbPath: string;
  provider: string;
  model: string;
  latestSchemaVersion: number;
}

export function runStats(options: StatsOptions = {}): StatsResult {
  const paths = requireProject(options.cwd);
  const config = loadConfig(paths, options);

  const db = openDb(paths.dbPath, { mustExist: true });
  try {
    const stats = getStats(db);
    return {
      ...stats,
      dbPath: paths.dbPath,
      provider: config.provider,
      model: config.model,
      latestSchemaVersion: LATEST_SCHEMA_VERSION,
    };
  } finally {
    db.close();
  }
}

function row(label: string, value: string | number): void {
  log.info(`  ${label.padEnd(22)}${style.bold(String(value))}`);
}

function breakdown(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'none';
  return entries.map(([k, n]) => `${k} ${n}`).join(', ');
}

export function printStats(stats: StatsResult): void {
  const rel = relative(process.cwd(), stats.dbPath) || stats.dbPath;

  log.info(style.bold('canon database'));
  row('path', rel);
  row('schema version', `${stats.schemaVersion} (latest ${stats.latestSchemaVersion})`);
  row('provider', `${stats.provider} / ${stats.model}`);
  log.info('');

  log.info(style.bold('corpus'));
  row('works', stats.works);
  row('sources', stats.sources);
  row('entities', stats.entities);
  log.info('');

  log.info(style.bold('claims'));
  row('total', stats.claims);
  row('by status', breakdown(stats.claimsByStatus));
  row('by modality', breakdown(stats.claimsByModality));
  log.info('');

  log.info(style.bold('activity'));
  row('runs', stats.runs);
  row('conflicts recorded', stats.conflicts);
  row('last run', stats.lastRunAt ?? 'never');

  if (stats.topEntities.length > 0) {
    log.info('');
    log.info(style.bold('most-documented entities'));
    for (const entity of stats.topEntities) {
      log.info(
        `  ${entity.name.padEnd(28).slice(0, 28)}${style.dim(entity.kind.padEnd(11))}` +
          `${style.bold(String(entity.claims))} claims`,
      );
    }
  }

  if (stats.claims === 0) {
    log.info('');
    log.info(
      style.dim('Nothing ingested yet. ') +
        style.cyan('canonlint ingest <file-or-dir> --work "Title"'),
    );
  }
}
