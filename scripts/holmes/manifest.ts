import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ExtractedClaim } from '../../src/ingest/extract.js';
import { ExtractedClaimSchema } from '../../src/ingest/extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const HolmesWorkSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  order: z.number().int().positive(),
  published: z.string().min(1),
  collection: z.string().min(1),
});

export type HolmesWork = z.infer<typeof HolmesWorkSchema>;

const WorksFileSchema = z.array(HolmesWorkSchema);

const ClaimsFileSchema = z.union([
  z.object({ claims: z.array(ExtractedClaimSchema) }),
  z.array(ExtractedClaimSchema),
]);

/** Publication-order catalog committed at `scripts/holmes/works.json`. */
export function defaultWorksPath(): string {
  return join(__dirname, 'works.json');
}

export function corpusWorksPath(corpusRoot: string): string {
  return join(corpusRoot, 'works.json');
}

/**
 * Load the Holmes publication-order catalog.
 *
 * Prefers `HOLMES_CORPUS_ROOT/works.json` when present; otherwise falls back to
 * the committed thin catalog (id/title/order/published/collection only).
 */
export function loadHolmesManifest(corpusRoot?: string): HolmesWork[] {
  const root = corpusRoot?.trim();
  const candidates = [
    ...(root ? [corpusWorksPath(root)] : []),
    defaultWorksPath(),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const works = WorksFileSchema.parse(raw);
    return [...works].sort((a, b) => a.order - b.order);
  }

  throw new Error(
    'Holmes works catalog not found. Commit scripts/holmes/works.json or set HOLMES_CORPUS_ROOT.',
  );
}

/** Load pre-extracted claims for one story (`{ claims: [...] }` or a bare array). */
export function loadStoryClaims(claimsPath: string): ExtractedClaim[] {
  const raw: unknown = JSON.parse(readFileSync(claimsPath, 'utf8'));
  const parsed = ClaimsFileSchema.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.claims;
}

export function storyTextPath(corpusRoot: string, workId: string): string {
  return join(corpusRoot, 'texts', `${workId}.txt`);
}

export function storyClaimsPath(corpusRoot: string, workId: string): string {
  return join(corpusRoot, 'claims', `${workId}.json`);
}
