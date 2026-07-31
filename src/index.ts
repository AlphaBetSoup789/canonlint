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
