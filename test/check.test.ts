import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { runIngest } from '../src/commands/ingest.js';
import { runCheck } from '../src/commands/check.js';
import { runMerge } from '../src/commands/merge.js';
import { openDb } from '../src/db/index.js';
import {
  findClaims,
  findEntityByNameOrAlias,
  getEntityAliases,
  listConflicts,
} from '../src/db/repo.js';
import { CLEAN_DRAFT_CLAIMS, DIRTY_DRAFT_CLAIMS } from './fixtures/check-claims.js';
import {
  CostedProvider,
  mockCheckProvider,
  mockIngestProvider,
} from './helpers/mockLlm.js';
import { SpendCapError } from '../src/util/errors.js';

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

  it('does not mutate canon entity aliases as a side effect', async () => {
    const draftPath = writeFixture('dirty-draft.md');

    const db = openDb(join(dir, '.canonlint', 'canon.db'), { mustExist: true });
    let aliasesBefore: string[];
    try {
      const voss = findEntityByNameOrAlias(db, 'Adrian Voss', 'character')!;
      aliasesBefore = getEntityAliases(voss);
    } finally {
      db.close();
    }

    await runCheck({
      cwd: dir,
      draft: draftPath,
      llm: mockCheckProvider(DIRTY_DRAFT_CLAIMS),
      maxSpendUsd: 1,
    });

    const db2 = openDb(join(dir, '.canonlint', 'canon.db'), { mustExist: true });
    try {
      const voss = findEntityByNameOrAlias(db2, 'Adrian Voss', 'character')!;
      expect(getEntityAliases(voss)).toEqual(aliasesBefore);
    } finally {
      db2.close();
    }
  });

  it('aborts mid-run once actual spend exceeds the cap', async () => {
    const draftPath = writeFixture('dirty-draft.md');
    const costed = new CostedProvider(
      mockCheckProvider(DIRTY_DRAFT_CLAIMS),
      // Cheap enough to pass the preflight estimate (extraction is 1 call),
      // but expensive enough that resolve + adjudicate calls blow the cap.
      0.05,
    );

    await expect(
      runCheck({
        cwd: dir,
        draft: draftPath,
        llm: costed,
        maxSpendUsd: 0.12,
      }),
    ).rejects.toBeInstanceOf(SpendCapError);
  });
});

describe('runMerge', () => {
  it('merges only the checked draft, not a more-recently-checked other draft', async () => {
    const cleanPath = writeFixture('clean-draft.md');
    const dirtyPath = writeFixture('dirty-draft.md');

    const cleanReport = await runCheck({
      cwd: dir,
      draft: cleanPath,
      llm: mockCheckProvider(CLEAN_DRAFT_CLAIMS),
      maxSpendUsd: 1,
    });
    expect(cleanReport.newFacts.length).toBeGreaterThanOrEqual(1);

    // Checked more recently, but has no new facts to leak into the merge below.
    await runCheck({
      cwd: dir,
      draft: dirtyPath,
      llm: mockCheckProvider(DIRTY_DRAFT_CLAIMS),
      maxSpendUsd: 1,
    });

    const merged = runMerge({ cwd: dir, draft: cleanPath });
    expect(merged.checkRunId).toBe(cleanReport.runId);
    expect(merged.promoted).toBeGreaterThanOrEqual(1);
  });

  it('reuses one entity across multiple new facts for the same new name', async () => {
    const draftPath = writeFixture('clean-draft.md');
    const extraClaims = [
      ...CLEAN_DRAFT_CLAIMS,
      {
        entity_name: 'Inspector Reyes',
        entity_kind: 'character' as const,
        entity_aliases: [],
        attribute: 'rank',
        value: 'inspector',
        modality: 'asserted' as const,
        confidence: 0.9,
        evidence_quote: 'preferred black coffee to tea',
        valid_from: null,
        valid_until: null,
      },
      {
        entity_name: 'Inspector Reyes',
        entity_kind: 'character' as const,
        entity_aliases: [],
        attribute: 'department',
        value: 'Harbour Street precinct',
        modality: 'asserted' as const,
        confidence: 0.9,
        evidence_quote: 'kept rooms at Number Seven, Grey Lane',
        valid_from: null,
        valid_until: null,
      },
    ];

    const report = await runCheck({
      cwd: dir,
      draft: draftPath,
      llm: mockCheckProvider(extraClaims),
      maxSpendUsd: 1,
    });
    const reyesFacts = report.newFacts.filter(
      (f) => f.draft.claim.entity_name === 'Inspector Reyes',
    );
    expect(reyesFacts.length).toBe(2);

    // Two new_fact conflicts for the same unresolved name must not crash
    // the merge on the (name, kind) unique constraint.
    expect(() => runMerge({ cwd: dir, draft: draftPath })).not.toThrow();

    const db = openDb(join(dir, '.canonlint', 'canon.db'), { mustExist: true });
    try {
      const reyes = db
        .prepare('SELECT COUNT(*) AS n FROM entities WHERE name = ?')
        .get('Inspector Reyes') as { n: number };
      expect(reyes.n).toBe(1);
      const claims = findClaims(db, { status: 'canon' }).filter(
        (c) => c.attribute === 'rank' || c.attribute === 'department',
      );
      expect(claims.length).toBe(2);
    } finally {
      db.close();
    }
  });

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
