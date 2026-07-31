import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { CanonlintError } from './util/errors.js';

export const PROJECT_DIR = '.canonlint';
export const DB_FILENAME = 'canon.db';
export const CONFIG_FILENAME = 'config.json';

export interface ProjectPaths {
  /** Directory containing `.canonlint/`. */
  root: string;
  /** The `.canonlint/` directory itself. */
  dir: string;
  dbPath: string;
  configPath: string;
}

export function pathsFor(root: string): ProjectPaths {
  const dir = join(root, PROJECT_DIR);
  return {
    root,
    dir,
    dbPath: join(dir, DB_FILENAME),
    configPath: join(dir, CONFIG_FILENAME),
  };
}

/**
 * Walk up from `start` looking for a `.canonlint/` directory, the way git finds
 * `.git`. Lets you run `canonlint check` from anywhere inside a project.
 */
export function findProject(start: string = process.cwd()): ProjectPaths | null {
  let current = resolve(start);
  const { root: fsRoot } = parse(current);

  for (;;) {
    if (existsSync(join(current, PROJECT_DIR))) {
      return pathsFor(current);
    }
    if (current === fsRoot) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Same as `findProject`, but throws the "run init first" message. */
export function requireProject(start: string = process.cwd()): ProjectPaths {
  const project = findProject(start);
  if (!project) {
    throw new CanonlintError(
      `No canon database found in ${resolve(start)} or any parent directory.\n` +
        `Run \`canonlint init\` to create one.`,
    );
  }
  return project;
}
