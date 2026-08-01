import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { CanonlintError } from '../util/errors.js';

const STORY_EXTENSIONS = new Set(['.txt', '.md', '.markdown']);

export interface LoadedCorpus {
  /** Absolute path the user pointed at. */
  rootPath: string;
  /** Individual story files in stable order. */
  files: { path: string; relativePath: string; text: string }[];
  /** Concatenated corpus text used for cost estimates. */
  text: string;
  /** Default work title when `--work` is omitted. */
  defaultTitle: string;
}

function isStoryFile(name: string): boolean {
  return STORY_EXTENSIONS.has(extname(name).toLowerCase());
}

function walkFiles(dir: string): string[] {
  const entries: Dirent[] = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (entry.isFile() && isStoryFile(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Load `.txt` / `.md` story text from a file or directory.
 */
export function loadCorpus(pathArg: string): LoadedCorpus {
  const rootPath = resolve(pathArg);
  if (!existsSync(rootPath)) {
    throw new CanonlintError(`Path not found: ${pathArg}`);
  }

  const stat = statSync(rootPath);
  let filePaths: string[];
  let defaultTitle: string;

  if (stat.isDirectory()) {
    filePaths = walkFiles(rootPath);
    if (filePaths.length === 0) {
      throw new CanonlintError(`No .txt or .md story files found under ${pathArg}.`);
    }
    defaultTitle = basename(rootPath);
  } else if (stat.isFile()) {
    if (!isStoryFile(rootPath)) {
      throw new CanonlintError(
        `Unsupported file type "${extname(rootPath)}". Ingest accepts .txt and .md.`,
      );
    }
    filePaths = [rootPath];
    defaultTitle = basename(rootPath, extname(rootPath));
  } else {
    throw new CanonlintError(`Not a file or directory: ${pathArg}`);
  }

  const files = filePaths.map((path) => {
    const text = readFileSync(path, 'utf8');
    if (text.trim() === '') {
      throw new CanonlintError(`Refusing to ingest empty file: ${path}`);
    }
    return {
      path,
      relativePath: relative(
        stat.isDirectory() ? rootPath : join(rootPath, '..'),
        path,
      ),
      text,
    };
  });

  const text = files.map((f) => f.text).join('\n\n');

  return { rootPath, files, text, defaultTitle };
}
