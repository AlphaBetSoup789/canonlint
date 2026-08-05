/**
 * M3.5 cost-control regression fixtures.
 *
 * These encode the known false positives from the Aug 2026 live audit and
 * must pass against the mock provider ($0) before any live corpus re-run.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  enforcePrecision,
  effectiveSummary,
  SAME_ENTITY_CONFIDENCE_THRESHOLD,
} from '../src/check/adjudicate.js';
import { clusterFindings, type CheckFinding } from '../src/check/report.js';
import { openDb, type Db } from '../src/db/index.js';
import {
  findEntityWorkAnomalies,
  insertClaim,
  insertEntity,
  insertSource,
  insertWork,
  listEntities,
} from '../src/db/repo.js';
import { ExtractedClaimSchema } from '../src/ingest/extract.js';
import { isNameTokenMatch, resolveEntity } from '../src/ingest/resolve.js';
import { MockProvider } from '../src/llm/mock.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

const greedyExisting = new MockProvider({
  responder: (req) => {
    if (!req.user.includes('entity resolution')) return '{}';
    const idMatch = /- id=(\d+)/.exec(req.user);
    return JSON.stringify({
      match: 'existing',
      entity_id: Number(idMatch?.[1] ?? 1),
      aliases: [],
    });
  },
});

describe('M3.5 regression: Achmet / generic-man magnet', () => {
  it('drops generic "a man" instead of resolving to Achmet', async () => {
    const work = insertWork(db, { title: 'The Sign of the Four' });
    const achmet = insertEntity(db, { name: 'Achmet', kind: 'character' });
    const src = insertSource(db, {
      work_id: work.id,
      locator: 'ch. XII',
      text_excerpt: 'little, fat, round, with a great yellow turban',
    });
    insertClaim(db, {
      entity_id: achmet.id,
      attribute: 'appearance',
      value: 'little fat round with yellow turban',
      modality: 'asserted',
      status: 'canon',
      source_id: src.id,
    });

    const result = await resolveEntity(db, greedyExisting, {
      name: 'a man',
      kind: 'character',
      subjectSpecificity: 'generic',
      workId: work.id,
      workTitle: work.title,
    });
    expect(result.dropped).toBe(true);
    expect(result.entity).toBeUndefined();
  });

  it('does not name-token-match generic descriptions to Achmet', () => {
    expect(isNameTokenMatch('a man', 'Achmet')).toBe(false);
    expect(isNameTokenMatch('the fellow', 'Achmet')).toBe(false);
    expect(isNameTokenMatch('our visitor', 'Achmet')).toBe(false);
  });
});

describe('M3.5 regression: Mary Morstan / Jabez Wilson / Mary Holder', () => {
  it('keeps Mary Morstan and Mary Holder as separate entities', async () => {
    insertEntity(db, { name: 'Mary Morstan', kind: 'character' });
    const result = await resolveEntity(db, greedyExisting, {
      name: 'Mary Holder',
      kind: 'character',
      subjectSpecificity: 'named',
    });
    expect(result.entity?.name).toBe('Mary Holder');
    expect(listEntities(db, 'character').map((e) => e.name).sort()).toEqual([
      'Mary Holder',
      'Mary Morstan',
    ]);
  });

  it('does not merge Jabez Wilson onto Mary Morstan via description', async () => {
    insertEntity(db, { name: 'Mary Morstan', kind: 'character' });
    const result = await resolveEntity(db, greedyExisting, {
      name: 'Jabez Wilson',
      kind: 'character',
      subjectSpecificity: 'named',
    });
    expect(result.entity?.name).toBe('Jabez Wilson');
    expect(result.entity?.id).not.toBe(1);
  });
});

describe('M3.5 regression: place collapse', () => {
  it('keeps Baker Street, Lauriston Gardens, Pondicherry, Birlstone apart', async () => {
    insertEntity(db, { name: '221B Baker Street', kind: 'place' });
    for (const place of [
      '3 Lauriston Gardens',
      'Pondicherry Lodge',
      'Birlstone Manor',
    ]) {
      const result = await resolveEntity(db, greedyExisting, {
        name: place,
        kind: 'place',
        subjectSpecificity: 'named',
      });
      expect(result.entity?.name).toBe(place);
    }
    expect(listEntities(db, 'place')).toHaveLength(4);
  });
});

describe('M3.5 regression: Turner wife / first-person speaker', () => {
  it('extraction schema requires subject_specificity and accepts figurative', () => {
    const claim = ExtractedClaimSchema.parse({
      entity_name: 'John Turner',
      entity_kind: 'character',
      entity_aliases: ['Turner'],
      subject_specificity: 'named',
      attribute: 'wife_status',
      value: 'died young',
      modality: 'asserted',
      confidence: 0.9,
      evidence_quote: 'my wife died young',
    });
    expect(claim.entity_name).toBe('John Turner');
    expect(claim.subject_specificity).toBe('named');

    const figurative = ExtractedClaimSchema.parse({
      entity_name: 'the bird',
      entity_kind: 'character',
      entity_aliases: [],
      subject_specificity: 'generic',
      attribute: 'status',
      value: 'escaped',
      modality: 'figurative',
      confidence: 0.8,
      evidence_quote: 'Found the cage empty and the bird escaped',
    });
    expect(figurative.modality).toBe('figurative');
  });
});

describe('M3.5 regression: figurative modality never adjudicates', () => {
  it('stores figurative claims in the modality CHECK', () => {
    const work = insertWork(db, { title: 'The Adventure of the Blue Carbuncle' });
    const entity = insertEntity(db, { name: 'John Horner', kind: 'character' });
    const src = insertSource(db, {
      work_id: work.id,
      locator: 'ch. 1',
      text_excerpt: 'Found the cage empty and the bird escaped',
    });
    const claim = insertClaim(db, {
      entity_id: entity.id,
      attribute: 'status',
      value: 'person fled (idiom)',
      modality: 'figurative',
      status: 'canon',
      source_id: src.id,
    });
    expect(claim.modality).toBe('figurative');
  });
});

describe('M3.5 regression: same_entity_confidence gate', () => {
  it('downgrades contradiction when identity confidence is below threshold', () => {
    const result = enforcePrecision(
      {
        verdict: 'contradiction',
        severity: 'high',
        explanation:
          'This description seems to belong to a different character, but…',
        canon_claim_id: 1,
        same_entity_confidence: 0.4,
      },
      [
        {
          id: 1,
          entity_id: 1,
          attribute: 'appearance',
          value: 'yellow turban',
          modality: 'asserted',
          valid_from: null,
          valid_until: null,
          branch: 'main',
          status: 'canon',
          superseded_by: null,
          source_id: 1,
          confidence: 1,
          created_at: '',
          entity_name: 'Achmet',
          entity_kind: 'character',
          work_title: 'The Sign of the Four',
          locator: 'ch. XII',
          text_excerpt: 'little fat round fellow',
        },
      ],
    );
    expect(result.verdict).toBe('needs_human');
    expect(result.explanation).toContain('same_entity_confidence');
    expect(SAME_ENTITY_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.4);
  });

  it('replaces bare "contradiction" summaries', () => {
    const summary = effectiveSummary(
      {
        verdict: 'contradiction',
        severity: 'high',
        explanation: 'Wound location differs.',
        summary: 'contradiction',
        same_entity_confidence: 1,
      },
      {
        entity_name: 'John Watson',
        entity_kind: 'character',
        entity_aliases: [],
        subject_specificity: 'named',
        attribute: 'war_wound',
        value: 'leg',
        modality: 'asserted',
        confidence: 1,
        evidence_quote: 'I was struck on the leg',
        valid_from: null,
        valid_until: null,
      },
      'John Watson',
    );
    expect(summary.toLowerCase()).not.toBe('contradiction');
    expect(summary).toContain('war_wound');
  });
});

describe('M3.5 regression: clustering + entity anomaly', () => {
  it('clusters findings by entity+attribute with occurrence counts', () => {
    const base = {
      kind: 'contradiction' as const,
      severity: 'high' as const,
      explanation: 'differs',
      draft: {
        path: '/tmp/x',
        locator: 'ch. 1',
        quote: 'quote',
        claim: {
          entity_name: 'John Watson',
          entity_kind: 'character' as const,
          entity_aliases: [],
          subject_specificity: 'named' as const,
          attribute: 'war_wound',
          value: 'leg',
          modality: 'asserted' as const,
          confidence: 1,
          evidence_quote: 'struck on the leg',
          valid_from: null,
          valid_until: null,
        },
      },
    };
    const findings: CheckFinding[] = [
      { ...base, summary: "Watson's war wound is leg." },
      { ...base, summary: "Watson's war wound is leg." },
      {
        ...base,
        summary: "Watson's residence is Baker Street.",
        draft: {
          ...base.draft,
          claim: { ...base.draft.claim, attribute: 'residence', value: 'Baker Street' },
        },
      },
    ];
    const clustered = clusterFindings(findings);
    expect(clustered).toHaveLength(2);
    const wound = clustered.find((c) => c.key.includes('war_wound'));
    expect(wound?.occurrences).toBe(2);
  });

  it('flags entities with claims from more than 8 works', () => {
    const entity = insertEntity(db, { name: 'Achmet', kind: 'character' });
    for (let i = 1; i <= 9; i++) {
      const work = insertWork(db, { title: `Story ${i}`, order_index: i });
      const src = insertSource(db, {
        work_id: work.id,
        locator: 'ch. 1',
        text_excerpt: `excerpt ${i}`,
      });
      insertClaim(db, {
        entity_id: entity.id,
        attribute: 'appearance',
        value: `desc ${i}`,
        modality: 'asserted',
        status: 'canon',
        source_id: src.id,
      });
    }
    const anomalies = findEntityWorkAnomalies(db);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.name).toBe('Achmet');
    expect(anomalies[0]!.workCount).toBe(9);
  });
});
