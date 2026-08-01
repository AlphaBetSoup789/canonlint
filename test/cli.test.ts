import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { runStats } from '../src/commands/stats.js';
import { findProject, requireProject, PROJECT_DIR } from '../src/paths.js';
import { LATEST_SCHEMA_VERSION } from '../src/db/index.js';
import { buildProgram } from '../src/cli.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canonlint-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('init', () => {
  it('creates a database, config, and self-ignoring directory', () => {
    const result = runInit({ cwd: dir });
    expect(result.created).toBe(true);
    expect(result.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(existsSync(result.paths.dbPath)).toBe(true);
    expect(existsSync(result.paths.configPath)).toBe(true);
    expect(readFileSync(join(result.paths.dir, '.gitignore'), 'utf8')).toContain('*');
  });

  it('refuses to clobber an existing database', () => {
    runInit({ cwd: dir });
    expect(() => runInit({ cwd: dir })).toThrow(/already exists/);
  });

  it('--force re-runs migrations without destroying data', () => {
    runInit({ cwd: dir });
    const before = readFileSync(join(dir, PROJECT_DIR, 'config.json'), 'utf8');
    const result = runInit({ cwd: dir, force: true });
    expect(result.created).toBe(false);
    expect(readFileSync(result.paths.configPath, 'utf8')).toBe(before);
  });

  it('adds .canonlint/ to an existing repo .gitignore', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
    runInit({ cwd: dir });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^\.canonlint\/$/m);
  });

  it('does not duplicate an existing .canonlint/ ignore entry', () => {
    writeFileSync(join(dir, '.gitignore'), '.canonlint/\n', 'utf8');
    runInit({ cwd: dir });
    const lines = readFileSync(join(dir, '.gitignore'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '.canonlint/');
    expect(lines).toHaveLength(1);
  });

  it('honours the provider passed at init time', () => {
    runInit({ cwd: dir, provider: 'ollama' });
    const config = JSON.parse(
      readFileSync(join(dir, PROJECT_DIR, 'config.json'), 'utf8'),
    );
    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('llama3.1:8b');
  });
});

describe('project discovery', () => {
  it('finds .canonlint/ from a nested directory, like git does', () => {
    runInit({ cwd: dir });
    const nested = join(dir, 'drafts', 'book-two');
    mkdirSync(nested, { recursive: true });
    expect(findProject(nested)?.root).toBe(dir);
  });

  it('explains itself when there is no project', () => {
    expect(() => requireProject(dir)).toThrow(/canonlint init/);
  });
});

describe('stats', () => {
  it('reports an empty, freshly-initialised database', () => {
    runInit({ cwd: dir });
    const stats = runStats({ cwd: dir });
    expect(stats.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(stats.latestSchemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(stats.works).toBe(0);
    expect(stats.claims).toBe(0);
    expect(stats.conflicts).toBe(0);
  });

  it('reflects the resolved provider and model', () => {
    runInit({ cwd: dir, provider: 'ollama' });
    const stats = runStats({ cwd: dir });
    expect(stats.provider).toBe('ollama');
    expect(stats.model).toBe('llama3.1:8b');
  });

  it('fails with a useful message before init', () => {
    expect(() => runStats({ cwd: dir })).toThrow(/canonlint init/);
  });
});

describe('cli surface', () => {
  it('declares the full v1 command set', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(['check', 'entity', 'ingest', 'init', 'merge', 'stats']);
  });

  it('exposes --max-spend on ingest', () => {
    const ingest = buildProgram().commands.find((c) => c.name() === 'ingest');
    const flags = ingest?.options.map((o) => o.long) ?? [];
    expect(flags).toContain('--max-spend');
    expect(flags).toContain('--review');
  });

  it('exposes check and merge options', () => {
    const check = buildProgram().commands.find((c) => c.name() === 'check');
    const merge = buildProgram().commands.find((c) => c.name() === 'merge');
    expect(check?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--json', '--out', '--max-spend']),
    );
    expect(merge?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--run', '--proposed']),
    );
  });
});
