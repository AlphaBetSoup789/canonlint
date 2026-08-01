/**
 * Library entry point. `canonlint` is a CLI first, but the pieces are exported
 * so they can be embedded in an editor plugin or a writing tool.
 */

export { VERSION } from './version.js';

export * from './db/types.js';
export {
  openDb,
  runMigrations,
  getSchemaVersion,
  LATEST_SCHEMA_VERSION,
  type Db,
  type OpenOptions,
} from './db/index.js';
export * as repo from './db/repo.js';
export { migrations, type Migration } from './db/migrations/index.js';

export * from './config.js';
export * from './paths.js';
export * from './llm/index.js';
export { CanonlintError, SpendCapError, isCanonlintError } from './util/errors.js';

export { runInit, type InitOptions, type InitResult } from './commands/init.js';
export { runStats, type StatsOptions, type StatsResult } from './commands/stats.js';
export {
  runIngest,
  printIngest,
  type IngestOptions,
  type IngestResult,
} from './commands/ingest.js';
export {
  runEntity,
  printEntity,
  type EntityOptions,
  type EntityResult,
} from './commands/entity.js';
export {
  runCheck,
  printCheck,
  type CheckOptions,
  type CheckResult,
} from './commands/check.js';
export {
  runMerge,
  printMerge,
  type MergeOptions,
  type MergeResult,
} from './commands/merge.js';
export * from './ingest/index.js';
export * from './check/index.js';
