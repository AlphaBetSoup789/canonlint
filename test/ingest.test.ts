import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { runIngest } from '../src/commands/ingest.js';
import { runEntity } from '../src/commands/entity.js';
import { openDb } from '../src/db/index.js';
import {
  findCitedClaims,
  findEntityByNameOrAlias,
  getEntityAliases,
  getStats,
} from '../src/db/repo.js';
import { MockProvider } from '../src/llm/mock.js';
import { SpendCapError } from '../src/util/errors.js';
import { miniExtractResponse } from './fixtures/mini-claims.js';
import { ADVERSARIAL_PASSAGES } from './fixtures/adversarial.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canonlint-ingest-'));
  runInit({ cwd: dir, provider: 'mock' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeMiniStory(): string {
  const src = readFileSync(join(import.meta.dirname, 'fixtures/mini-story.md'), 'utf8');
  const path = join(dir, 'mini-story.md');
  writeFileSync(path, src, 'utf8');
  return path;
}

function mockIngestProvider(): MockProvider {
  return new MockProvider({
    responder: (req) => {
      if (req.user.includes('entity resolution')) {
        // Prefer matching Adrian Voss / Helen Carr / Mrs. Bramley by name hints.
        const surface = /Surface name: (.+)/.exec(req.user)?.[1]?.trim() ?? '';
        const idLines = [...req.user.matchAll(/- id=(\d+) name="([^"]+)"/g)];
        const lower = surface.toLowerCase();
        for (const m of idLines) {
          const id = Number(m[1]);
          const name = (m[2] ?? '').toLowerCase();
          if (
            name === lower ||
            lower.includes(name) ||
            name.includes(lower) ||
            (lower.includes('voss') && name.includes('voss')) ||
            (lower.includes('carr') && name.includes('carr')) ||
            (lower.includes('bramley') && name.includes('bramley')) ||
            (lower.includes('trent') && name.includes('trent')) ||
            (lower.includes('cole') && name.includes('cole')) ||
            (lower.includes('wilde') && name.includes('wilde'))
          ) {
            return JSON.stringify({
              match: 'existing',
              entity_id: id,
              aliases: [surface],
            });
          }
        }
        return JSON.stringify({
          match: 'new',
          canonical_name: surface,
          aliases: [],
        });
      }
      return miniExtractResponse();
    },
  });
}

describe('runIngest', () => {
  it('ingests ≥30 provenanced claims and merges entity aliases', async () => {
    const storyPath = writeMiniStory();
    const llm = mockIngestProvider();

    const result = await runIngest({
      cwd: dir,
      path: storyPath,
      work: 'The Lodger at Number Seven',
      order: 1,
      llm,
      maxSpendUsd: 0, // mock estimates $0
    });

    expect(result.claimsInserted).toBeGreaterThanOrEqual(30);
    expect(result.sourcesInserted).toBe(result.claimsInserted);
    expect(result.chunks).toBeGreaterThan(0);

    const db = openDb(join(dir, '.canonlint', 'canon.db'), { mustExist: true });
    try {
      const stats = getStats(db);
      expect(stats.claims).toBeGreaterThanOrEqual(30);
      expect(stats.sources).toBe(stats.claims);

      const cited = findCitedClaims(db);
      expect(cited.every((c) => c.text_excerpt.trim().length > 0)).toBe(true);

      const voss = findEntityByNameOrAlias(db, 'Voss', 'character');
      expect(voss).toBeTruthy();
      const adrian = findEntityByNameOrAlias(db, 'Adrian Voss', 'character');
      expect(adrian?.id).toBe(voss?.id);
      const aliases = getEntityAliases(voss!);
      expect(aliases.map((a) => a.toLowerCase()).some((a) => a.includes('voss'))).toBe(
        true,
      );

      const carr = findEntityByNameOrAlias(db, 'my dear Carr', 'character');
      expect(carr?.name).toMatch(/Carr/i);
    } finally {
      db.close();
    }
  });

  it('refuses when the spend estimate exceeds the cap', async () => {
    // Force anthropic pricing on a large blob so the estimate is non-zero.
    const big = join(dir, 'big.md');
    writeFileSync(big, `${'word '.repeat(50_000)}\n`, 'utf8');
    // Rewrite config to anthropic for cost estimation.
    writeFileSync(
      join(dir, '.canonlint', 'config.json'),
      JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5' }, null, 2),
      'utf8',
    );

    await expect(
      runIngest({
        cwd: dir,
        path: big,
        work: 'Big',
        maxSpendUsd: 0.01,
        llm: new MockProvider(),
      }),
    ).rejects.toBeInstanceOf(SpendCapError);
  });

  it('supports --review via an injected prompt', async () => {
    const storyPath = writeMiniStory();
    // Low-confidence claims stay proposed then get reviewed.
    const llm = new MockProvider({
      responder: (req) => {
        if (req.user.includes('entity resolution')) {
          return JSON.stringify({ match: 'new', canonical_name: 'Adrian Voss' });
        }
        return JSON.stringify({
          claims: [
            {
              entity_name: 'Adrian Voss',
              entity_kind: 'character',
              entity_aliases: [],
              attribute: 'occupation',
              value: 'consulting detective',
              modality: 'asserted',
              confidence: 0.5,
              evidence_quote: 'consulting detective',
              valid_from: null,
              valid_until: null,
            },
          ],
        });
      },
    });

    const answers = ['y'];
    const result = await runIngest({
      cwd: dir,
      path: storyPath,
      work: 'Review Tale',
      review: true,
      llm,
      reviewPrompt: async () => answers.shift() ?? 's',
      maxSpendUsd: 1,
    });

    expect(result.claimsCanon).toBe(1);
    expect(result.claimsRejected).toBe(0);
  });

  it('still wraps adversarial corpus text as untrusted data', async () => {
    const passage = ADVERSARIAL_PASSAGES[0]!.text;
    const path = join(dir, 'adv.md');
    // Include a benign quotable sentence so a claim can land if returned.
    writeFileSync(
      path,
      `${passage}\n\nAdrian Voss was a consulting detective.\n`,
      'utf8',
    );

    const llm = new MockProvider({
      responder: (req) => {
        expect(req.system).toMatch(/UNTRUSTED DATA/);
        expect(req.user).toContain('CANONLINT_UNTRUSTED_');
        if (req.user.includes('entity resolution')) {
          return JSON.stringify({ match: 'new', canonical_name: 'Adrian Voss' });
        }
        return JSON.stringify({
          claims: [
            {
              entity_name: 'Adrian Voss',
              entity_kind: 'character',
              entity_aliases: [],
              attribute: 'occupation',
              value: 'consulting detective',
              modality: 'asserted',
              confidence: 0.9,
              evidence_quote: 'consulting detective',
              valid_from: null,
              valid_until: null,
            },
          ],
        });
      },
    });

    const result = await runIngest({
      cwd: dir,
      path,
      work: 'Adversarial',
      llm,
      maxSpendUsd: 1,
    });
    expect(result.claimsInserted).toBe(1);
  });
});

describe('runEntity', () => {
  it('looks up an entity by alias after ingest', async () => {
    const storyPath = writeMiniStory();
    await runIngest({
      cwd: dir,
      path: storyPath,
      work: 'The Lodger at Number Seven',
      llm: mockIngestProvider(),
      maxSpendUsd: 1,
    });

    const result = runEntity({ cwd: dir, name: 'Voss' });
    expect(result.entity.name).toMatch(/Voss/i);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims[0]?.text_excerpt.length).toBeGreaterThan(0);
  });
});
