import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { openDb, LATEST_SCHEMA_VERSION } from '../db/index.js';
import { pathsFor, PROJECT_DIR, type ProjectPaths } from '../paths.js';
import { writeFileConfig, DEFAULTS, type FileConfig } from '../config.js';
import { CanonlintError } from '../util/errors.js';
import { log, style } from '../util/logger.js';

export interface InitOptions {
  cwd?: string;
  force?: boolean;
  provider?: string;
  model?: string;
}

export interface InitResult {
  paths: ProjectPaths;
  created: boolean;
  schemaVersion: number;
}

/**
 * Create `.canonlint/` in the current directory: the SQLite canon database, a
 * config file, and a `.gitignore` that keeps the database out of version
 * control by default.
 *
 * That last part is not a nicety. A canon database contains verbatim excerpts
 * from whatever was ingested; committing one built from copyrighted work would
 * be distributing derivative content.
 */
export function runInit(options: InitOptions = {}): InitResult {
  const root = resolve(options.cwd ?? process.cwd());
  const paths = pathsFor(root);

  const alreadyExists = existsSync(paths.dbPath);
  if (alreadyExists && !options.force) {
    throw new CanonlintError(
      `A canon database already exists at ${relative(root, paths.dbPath) || paths.dbPath}.\n` +
        `Nothing was changed. Use \`canonlint init --force\` to re-apply ` +
        `migrations and refresh the ignore file (existing data is preserved).`,
    );
  }

  mkdirSync(paths.dir, { recursive: true });

  const db = openDb(paths.dbPath);
  const schemaVersion = LATEST_SCHEMA_VERSION;
  db.close();

  if (!existsSync(paths.configPath)) {
    const config: FileConfig = {
      provider: (options.provider as FileConfig['provider']) ?? DEFAULTS.provider,
      model:
        options.model ??
        (options.provider === 'ollama'
          ? DEFAULTS.ollamaModel
          : DEFAULTS.anthropicModel),
      chunkWords: DEFAULTS.chunkWords,
      maxSpendUsd: DEFAULTS.maxSpendUsd,
    };
    writeFileConfig(paths, config);
  }

  writeLocalIgnore(paths);
  ensureRepoIgnore(root);

  return { paths, created: !alreadyExists, schemaVersion };
}

/**
 * Belt and braces: even if the user's repo `.gitignore` is never touched, the
 * database directory ignores itself.
 */
function writeLocalIgnore(paths: ProjectPaths): void {
  const body = [
    '# Written by `canonlint init`.',
    '#',
    '# A canon database holds verbatim excerpts from every work you ingest.',
    '# Committing one built from copyrighted material would distribute',
    '# derivative content. Keep it local.',
    '*',
    '',
  ].join('\n');
  writeFileSync(join(paths.dir, '.gitignore'), body, 'utf8');
}

/** Add `.canonlint/` to the repo's own .gitignore if there is one and it is absent. */
function ensureRepoIgnore(root: string): boolean {
  const ignorePath = join(root, '.gitignore');
  if (!existsSync(ignorePath)) return false;
  const current = readFileSync(ignorePath, 'utf8');
  if (/^\.canonlint\/?\s*$/m.test(current)) return false;
  const suffix = current.endsWith('\n') || current === '' ? '' : '\n';
  writeFileSync(
    ignorePath,
    `${current}${suffix}\n# canonlint: canon databases stay local\n${PROJECT_DIR}/\n`,
    'utf8',
  );
  return true;
}

export function printInit(result: InitResult): void {
  const rel = relative(process.cwd(), result.paths.dir) || PROJECT_DIR;
  if (result.created) {
    log.success(`Initialised a canon database in ${style.bold(rel)}`);
  } else {
    log.success(`Refreshed the canon database in ${style.bold(rel)}`);
  }
  log.detail(`schema version ${result.schemaVersion}`);
  log.detail(`config: ${rel}/config.json`);
  log.info('');
  log.info(`Next: ${style.cyan('canonlint ingest <file-or-dir> --work "Title"')}`);
}
