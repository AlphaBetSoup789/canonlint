/**
 * Split story text into extraction-sized chunks.
 *
 * Prefer chapter/scene boundaries so evidence locators stay meaningful; fall
 * back to a soft word-budget split when a section is larger than the target.
 */

export interface TextChunk {
  /** Human-readable pointer into the work (e.g. "ch. 2" or "file.md §3"). */
  label: string;
  text: string;
  /** 0-based index among all chunks for this ingest. */
  index: number;
  wordCount: number;
}

const HEADER_RE = /^(#{1,3}\s+\S.*|CHAPTER\b.*)$/im;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function splitByHeaders(text: string): { heading: string | null; body: string }[] {
  const lines = text.split(/\r?\n/);
  const sections: { heading: string | null; body: string }[] = [];
  let heading: string | null = null;
  let bodyLines: string[] = [];

  const flush = (): void => {
    const body = bodyLines.join('\n').trim();
    if (heading === null && body === '') return;
    sections.push({ heading, body: bodyLines.join('\n') });
    bodyLines = [];
  };

  for (const line of lines) {
    if (HEADER_RE.test(line.trim())) {
      flush();
      heading = line.trim();
    } else {
      bodyLines.push(line);
    }
  }
  flush();

  if (sections.length === 0) {
    return [{ heading: null, body: text }];
  }
  return sections;
}

function packWords(text: string, maxWords: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= maxWords) return [text.trim()];

  const parts: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    parts.push(words.slice(i, i + maxWords).join(' '));
  }
  return parts;
}

function sectionLabel(
  heading: string | null,
  fileLabel: string | undefined,
  sectionIndex: number,
  partIndex: number,
  partCount: number,
): string {
  let base: string;
  if (heading) {
    const cleaned = heading.replace(/^#+\s*/, '').trim();
    base = cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned;
  } else if (fileLabel) {
    base = fileLabel;
  } else {
    base = `section ${sectionIndex + 1}`;
  }
  if (partCount > 1) {
    return `${base} (part ${partIndex + 1}/${partCount})`;
  }
  return base;
}

export interface ChunkOptions {
  /** Target chunk size in words. */
  chunkWords: number;
  /** Optional file-relative path used when there are no chapter headers. */
  fileLabel?: string;
  /** Starting index for chunk numbering across multiple files. */
  startIndex?: number;
}

/**
 * Chunk a single document's text.
 */
export function chunkText(text: string, options: ChunkOptions): TextChunk[] {
  const { chunkWords, fileLabel, startIndex = 0 } = options;
  if (chunkWords < 1) {
    throw new Error('chunkWords must be a positive integer');
  }

  const sections = splitByHeaders(text);
  const chunks: TextChunk[] = [];
  let index = startIndex;

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;
    const body = section.body.trim();
    if (body === '' && !section.heading) continue;
    const material = body === '' ? (section.heading ?? '') : body;
    if (material.trim() === '') continue;

    const parts = packWords(material, chunkWords);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p]!;
      chunks.push({
        label: sectionLabel(section.heading, fileLabel, s, p, parts.length),
        text: part,
        index,
        wordCount: countWords(part),
      });
      index += 1;
    }
  }

  return chunks;
}

/**
 * Chunk every file in a loaded corpus, preserving per-file labels.
 */
export function chunkCorpus(
  files: { relativePath: string; text: string }[],
  chunkWords: number,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const file of files) {
    const next = chunkText(file.text, {
      chunkWords,
      fileLabel: file.relativePath,
      startIndex: chunks.length,
    });
    chunks.push(...next);
  }
  return chunks;
}
