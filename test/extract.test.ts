import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evidenceInChunk,
  extractClaimsFromChunk,
  filterProvenancedClaims,
  type ExtractedClaim,
} from '../src/ingest/extract.js';
import { chunkText } from '../src/ingest/chunk.js';
import { MockProvider } from '../src/llm/mock.js';

const MINI = readFileSync(join(import.meta.dirname, 'fixtures/mini-story.md'), 'utf8');

function claim(
  partial: Partial<ExtractedClaim> &
    Pick<ExtractedClaim, 'entity_name' | 'attribute' | 'value' | 'evidence_quote'>,
): ExtractedClaim {
  return {
    entity_kind: 'character',
    entity_aliases: [],
    modality: 'asserted',
    confidence: 0.9,
    valid_from: null,
    valid_until: null,
    ...partial,
  };
}

describe('evidenceInChunk', () => {
  it('accepts exact and whitespace-collapsed quotes', () => {
    expect(evidenceInChunk('wet Tuesday', 'on a wet Tuesday in March')).toBe(true);
    expect(evidenceInChunk('wet   Tuesday', 'on a wet Tuesday in March')).toBe(true);
    expect(evidenceInChunk('not in the text', 'on a wet Tuesday')).toBe(false);
  });
});

describe('filterProvenancedClaims', () => {
  it('drops claims whose evidence is not in the chunk', () => {
    const { kept, dropped } = filterProvenancedClaims(
      [
        claim({
          entity_name: 'Adrian Voss',
          attribute: 'occupation',
          value: 'consulting detective',
          evidence_quote: 'consulting detective',
        }),
        claim({
          entity_name: 'Adrian Voss',
          attribute: 'secret',
          value: 'invented',
          evidence_quote: 'THIS QUOTE IS FABRICATED',
        }),
      ],
      MINI,
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

describe('extractClaimsFromChunk', () => {
  it('uses the untrusted envelope and returns parsed claims', async () => {
    const chunk = chunkText(MINI, { chunkWords: 900 }).find((c) =>
      c.text.includes('Adrian Voss'),
    )!;
    expect(chunk).toBeTruthy();
    const provider = new MockProvider({
      responder: (req) => {
        expect(req.system).toMatch(/UNTRUSTED DATA/);
        expect(req.system).not.toContain('Adrian Voss');
        expect(req.user).toContain('CANONLINT_UNTRUSTED_');
        expect(req.user).toContain('Adrian Voss');
        return JSON.stringify({
          claims: [
            {
              entity_name: 'Adrian Voss',
              entity_kind: 'character',
              entity_aliases: ['Voss'],
              attribute: 'occupation',
              value: 'consulting detective',
              modality: 'asserted',
              confidence: 0.95,
              evidence_quote: 'consulting detective',
              valid_from: null,
              valid_until: null,
            },
          ],
        });
      },
    });

    const result = await extractClaimsFromChunk(provider, chunk);
    expect(result.refused).toBe(false);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.entity_name).toBe('Adrian Voss');
    expect(result.droppedUnprovenanced).toBe(0);
  });

  it('skips refused completions', async () => {
    const chunk = chunkText(MINI, { chunkWords: 900 })[0]!;
    const provider = new MockProvider({
      responder: () => ({ text: '', refused: true }),
    });
    const result = await extractClaimsFromChunk(provider, chunk);
    expect(result.refused).toBe(true);
    expect(result.claims).toHaveLength(0);
  });

  it('reports parse errors without throwing', async () => {
    const chunk = chunkText(MINI, { chunkWords: 900 })[0]!;
    const provider = new MockProvider({
      responder: () => 'not-json',
    });
    const result = await extractClaimsFromChunk(provider, chunk);
    expect(result.parseError).toBeTruthy();
    expect(result.claims).toHaveLength(0);
  });
});
