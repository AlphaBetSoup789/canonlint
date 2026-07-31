import { describe, expect, it } from 'vitest';
import {
  getSchemaVersion,
  LATEST_SCHEMA_VERSION,
  openDb,
  runMigrations,
} from '../src/db/index.js';
import { migrations } from '../src/db/migrations/index.js';

describe('migrations', () => {
  it('brings an empty database to the latest version', () => {
    const db = openDb(':memory:');
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = openDb(':memory:');
    expect(runMigrations(db)).toEqual([]);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('records every applied migration', () => {
    const db = openDb(':memory:');
    const rows = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string }[];
    expect(rows.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
    db.close();
  });

  it('uses strictly increasing, unique versions starting at 1', () => {
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions[0]).toBe(1);
  });

  it('refuses a database from a newer canonlint', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
      LATEST_SCHEMA_VERSION + 5,
      'from-the-future',
    );
    expect(() => runMigrations(db)).toThrow(/only understands version/);
    db.close();
  });

  it('creates every v1 table', () => {
    const db = openDb(':memory:');
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    for (const table of [
      'works',
      'sources',
      'entities',
      'claims',
      'runs',
      'conflicts',
      'schema_migrations',
    ]) {
      expect(tables, `missing table ${table}`).toContain(table);
    }
    db.close();
  });

  it('enables foreign keys and WAL', () => {
    const db = openDb(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});
