import { migration001 } from './001_init.js';
import { migration002 } from './002_figurative_modality.js';
import type { Migration } from './types.js';

export type { Migration } from './types.js';

/**
 * Ordered list of every migration. Append only — a shipped migration's
 * version, name, and SQL are immutable, because existing databases have
 * already applied them.
 */
export const migrations: readonly Migration[] = [migration001, migration002];

export const LATEST_SCHEMA_VERSION = migrations.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);
