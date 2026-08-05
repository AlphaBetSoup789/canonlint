import { describe, expect, it } from 'vitest';
import { enforcePrecision, toConflictKind } from '../src/check/adjudicate.js';
import type { CitedClaim } from '../src/db/repo.js';

function cited(partial: Partial<CitedClaim> & Pick<CitedClaim, 'id'>): CitedClaim {
  return {
    entity_id: 1,
    attribute: 'occupation',
    value: 'physician',
    modality: 'asserted',
    valid_from: null,
    valid_until: null,
    branch: 'main',
    status: 'canon',
    superseded_by: null,
    source_id: 1,
    confidence: 1,
    created_at: '',
    entity_name: 'Helen Carr',
    entity_kind: 'character',
    work_title: 'The Lodger',
    locator: 'ch. 1',
    text_excerpt: 'I am a physician',
    ...partial,
  };
}

describe('enforcePrecision', () => {
  it('downgrades contradiction without a cited canon claim', () => {
    const result = enforcePrecision(
      {
        verdict: 'contradiction',
        severity: 'high',
        explanation: 'Looks wrong',
        canon_claim_id: null,
        same_entity_confidence: 1,
      },
      [cited({ id: 1 })],
    );
    expect(result.verdict).toBe('needs_human');
  });

  it('downgrades when canon_claim_id is not in candidates', () => {
    const result = enforcePrecision(
      {
        verdict: 'timeline',
        severity: 'medium',
        explanation: 'Order is off',
        canon_claim_id: 99,
        same_entity_confidence: 1,
      },
      [cited({ id: 1 })],
    );
    expect(result.verdict).toBe('needs_human');
  });

  it('keeps contradiction when the citation is valid and identity is confident', () => {
    const result = enforcePrecision(
      {
        verdict: 'contradiction',
        severity: 'high',
        explanation: 'Solicitor ≠ physician',
        canon_claim_id: 1,
        same_entity_confidence: 0.95,
      },
      [cited({ id: 1 })],
    );
    expect(result.verdict).toBe('contradiction');
  });

  it('downgrades when same_entity_confidence is below threshold', () => {
    const result = enforcePrecision(
      {
        verdict: 'contradiction',
        severity: 'high',
        explanation: 'Looks like a different person',
        canon_claim_id: 1,
        same_entity_confidence: 0.2,
      },
      [cited({ id: 1 })],
    );
    expect(result.verdict).toBe('needs_human');
  });
});

describe('toConflictKind', () => {
  it('maps needs_human to uncertain and consistent to null', () => {
    expect(toConflictKind('needs_human')).toBe('uncertain');
    expect(toConflictKind('consistent')).toBeNull();
    expect(toConflictKind('contradiction')).toBe('contradiction');
  });
});
