import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { runIngest } from '../src/commands/ingest.js';
import { runCheck } from '../src/commands/check.js';
import { runMerge } from '../src/commands/merge.js';
import { openDb } from '../src/db/index.js';
import { findClaims, listConflicts } from '../src/db/repo.js';
import { CLEAN_DRAFT_CLAIMS, DIRTY_DRAFT_CLAIMS } from './fixtures/check-claims.js';
import { mockCheckProvider, mockIngestProvider } from './helpers/mockLlm.js';

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canonlint-check-'));
  runInit({ cwd: dir, provider: 'mock' });
  const story = readFileSync(
    join(import.meta.dirname, 'fixtures/mini-story.md'),
    'utf8',
  );
  const storyPath = join(dir, 'mini-story.md');
  writeFileSync(storyPath, story, 'utf8');
  await runIngest({
    cwd: dir,
    path: storyPath,
    work: 'The Lodger at Number Seven',
    order: 1,
    llm: mockIngestProvider(),
    maxSpendUsd: 1,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFixture(name: 'dirty-draft.md' | 'clean-draft.md'): string {
  const src = readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
  const path = join(dir, name);
  writeFileSync(path, src, 'utf8');
  return path;
}

describe('runCheck acceptance', () => {
  it('catches ≥4 of 5 planted contradictions with canon citations', async () => {
    const draftPath = writeFixture('dirty-draft.md');
    const report = await runCheck({
      cwd: dir,
      draft: draftPath,
      llm: mockCheckProvider(DIRTY_DRAFT_CLAIMS),
      maxSpendUsd: 1,
    });

    expect(report.contradictions.length).toBeGreaterThanOrEqual(4);
    expect(report.contradictions.length).toBeLessThanOrEqual(5);

    for (const finding of report.contradictions) {
      expect(finding.canon).toBeTruthy();
      expect(finding.canon!.excerpt.trim().length).toBeGreaterThan(0);
      expect(finding.draft.quote.trim().length).toBeGreaterThan(0);
    }

    const db = openDb(join(dir, '.canonlint', 'canon.db'), { mustExist: true });
    try {
      const conflicts = listConflicts(db, {
        runId: report.runId,
        kind: 'contradiction',
      });
      expect(conflicts.length).toBe(report.contradictions.length);
      expect(conflicts.every((c) => c.canon_claim_id != null)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('has ≤1 false-positive contradiction on a clean draft', async () => {
    const draftPath = writeFixture('clean-draft.md');
    const report = await runCheck({
      cwd: dir,
      draft: draftPath,
      llm: mockCheckProvider(CLEAN_DRAFT_CLAIMS),
      maxSpendUsd: 1,
    });

    expect(report.contradictions.length).toBeLessThanOrEqual(1);
    expect(report.newFacts.length).toBeGreaterThanOrEqual(1);
    expect(
      report.newFacts.some((f) => f.draft.claim.attribute === 'chemical_catalog'),
    ).toBe(true);
  });
});

describe('runMerge', () => {
  it('promotes open new_fact conflicts into canon', async () => {
    const draftPath = writeFixture('clean-draft.md');
    const report = await runCheck({
      cwd: dir,
      draft: draftPath,
      llm: mockCheckProvider(CLEAN_DRAFT_CLAIMS),
      maxSpendUsd: 1,
    });
    expect(report.newFacts.length).toBeGreaterThanOrEqual(1);

    const merged = runMerge({ cwd: dir, draft: draftPath });
    expect(merged.checkRunId).toBe(report.runId);
    expect(merged.promoted).toBeGreaterThanOrEqual(1);

    const db = openDb(join(dir, '.canonlint', 'canon.db'), { mustExist: true });
    try {
      const catalog = findClaims(db, {
        attribute: 'chemical_catalog',
        status: 'canon',
      });
      expect(catalog.length).toBeGreaterThanOrEqual(1);
      const open = listConflicts(db, {
        runId: report.runId,
        kind: 'new_fact',
        verdict: 'open',
      });
      expect(open).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
