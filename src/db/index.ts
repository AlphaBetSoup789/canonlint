import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { migrations, LATEST_SCHEMA_VERSION } from './migrations/index.js';
import { CanonlintError } from '../util/errors.js';

export type Db = Database.Database;

export { LATEST_SCHEMA_VERSION };

export interface OpenOptions {
  /** Fail instead of creating the file if the database does not exist. */
  mustExist?: boolean;
  /** Apply pending migrations on open. Default true. */
  migrate?: boolean;
  readonly?: boolean;
}

/**
 * Open (or create) a canon database and bring it to the latest schema version.
 *
 * `:memory:` is accepted and used by the test suite.
 */
export function openDb(path: string, options: OpenOptions = {}): Db {
  const { mustExist = false, migrate = true, readonly = false } = options;

  if (path !== ':memory:' && !mustExist) {
    mkdirSync(dirname(path), { recursive: true });
  }

  let db: Db;
  try {
    db = new Database(path, { fileMustExist: mustExist, readonly });
  } catch (err) {
    throw new CanonlintError(
      `Could not open canon database at ${path}` +
        (mustExist ? ` — run \`canonlint init\` first.` : '.'),
      { cause: err },
    );
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (migrate && !readonly) {
    runMigrations(db);
  }

  return db;
}

/** Current applied schema version. 0 means "empty database". */
export function getSchemaVersion(db: Db): number {
  ensureMigrationsTable(db);
  const row = db
    .prepare<[], { version: number | null }>(
      'SELECT MAX(version) AS version FROM schema_migrations',
    )
    .get();
  return row?.version ?? 0;
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Apply every migration newer than the recorded version.
 *
 * Each migration runs in its own transaction: a failure leaves the database at
 * the last fully-applied version rather than half-migrated.
 */
export function runMigrations(db: Db): number[] {
  ensureMigrationsTable(db);
  const current = getSchemaVersion(db);

  if (current > LATEST_SCHEMA_VERSION) {
    throw new CanonlintError(
      `This canon database is at schema version ${current}, but this build of ` +
        `canonlint only understands version ${LATEST_SCHEMA_VERSION}. ` +
        `Upgrade canonlint rather than downgrading the database.`,
    );
  }

  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  const record = db.prepare<[number, string]>(
    'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
  );

  const applied: number[] = [];
  for (const migration of pending) {
    // Some migrations rebuild tables (SQLite cannot ALTER CHECK). That requires
    // foreign_keys OFF, and the pragma is a no-op inside a transaction — so
    // flip it around the transaction, not inside migration SQL.
    db.pragma('foreign_keys = OFF');
    try {
      const apply = db.transaction(() => {
        db.exec(migration.up);
        record.run(migration.version, migration.name);
      });
      apply();
      applied.push(migration.version);
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  return applied;
}
