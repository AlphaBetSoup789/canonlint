import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import {
  addEntityAliases,
  findCitedClaims,
  findClaims,
  findEntityByNameOrAlias,
  getStats,
  insertClaim,
  insertConflict,
  insertEntity,
  insertRun,
  insertSource,
  insertWork,
  listEntities,
  setClaimStatus,
  supersedeClaim,
  upsertEntity,
  upsertWork,
} from '../src/db/repo.js';

let db: Db;

/** A minimal but complete chain: work -> source -> entity -> claim. */
function seed(db: Db) {
  const work = insertWork(db, { title: 'A Study in Scarlet', order_index: 1 });
  const source = insertSource(db, {
    work_id: work.id,
    locator: 'ch. 1',
    text_excerpt:
      'I had neither kith nor kin in England, and was therefore as free as air.',
  });
  const entity = insertEntity(db, { name: 'John Watson', kind: 'character' });
  return { work, source, entity };
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('provenance is enforced by the schema, not by convention', () => {
  it('rejects a claim with no source', () => {
    const { entity } = seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO claims (entity_id, attribute, value, modality, status, source_id)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(entity.id, 'nationality', 'English', 'asserted', 'canon'),
    ).toThrow();
  });

  it('rejects a claim pointing at a source that does not exist', () => {
    const { entity } = seed(db);
    expect(() =>
      insertClaim(db, {
        entity_id: entity.id,
        attribute: 'nationality',
        value: 'English',
        modality: 'asserted',
        status: 'canon',
        source_id: 9999,
      }),
    ).toThrow();
  });

  it('rejects a source with an empty excerpt', () => {
    const work = insertWork(db, { title: 'The Sign of the Four' });
    expect(() =>
      insertSource(db, { work_id: work.id, locator: 'ch. 1', text_excerpt: '   ' }),
    ).toThrow(/empty excerpt/i);
  });

  it('refuses to delete a source that a claim still cites', () => {
    const { entity, source } = seed(db);
    insertClaim(db, {
      entity_id: entity.id,
      attribute: 'nationality',
      value: 'English',
      modality: 'asserted',
      status: 'canon',
      source_id: source.id,
    });
    expect(() =>
      db.prepare('DELETE FROM sources WHERE id = ?').run(source.id),
    ).toThrow();
  });
});

describe('enum constraints', () => {
  it('rejects an unknown modality', () => {
    const { entity, source } = seed(db);
    expect(() =>
      insertClaim(db, {
        entity_id: entity.id,
        attribute: 'mood',
        value: 'brooding',
        // @ts-expect-error deliberately invalid
        modality: 'probably',
        status: 'canon',
        source_id: source.id,
      }),
    ).toThrow();
  });

  it('accepts figurative modality after migration 002', () => {
    const { entity, source } = seed(db);
    const claim = insertClaim(db, {
      entity_id: entity.id,
      attribute: 'status',
      value: 'the bird has flown',
      modality: 'figurative',
      status: 'canon',
      source_id: source.id,
    });
    expect(claim.modality).toBe('figurative');
  });

  it('rejects an unknown entity kind', () => {
    // @ts-expect-error deliberately invalid
    expect(() => insertEntity(db, { name: 'The Fog', kind: 'weather' })).toThrow();
  });

  it('rejects a confidence outside 0..1', () => {
    const { entity, source } = seed(db);
    expect(() =>
      insertClaim(db, {
        entity_id: entity.id,
        attribute: 'nationality',
        value: 'English',
        modality: 'asserted',
        status: 'canon',
        source_id: source.id,
        confidence: 1.5,
      }),
    ).toThrow();
  });
});

describe('retcons supersede, never delete', () => {
  it('keeps the old claim and links it to its replacement', () => {
    const { entity, source } = seed(db);
    const old = insertClaim(db, {
      entity_id: entity.id,
      attribute: 'wound_location',
      value: 'shoulder',
      modality: 'asserted',
      status: 'canon',
      source_id: source.id,
    });
    const replacement = insertClaim(db, {
      entity_id: entity.id,
      attribute: 'wound_location',
      value: 'leg',
      modality: 'asserted',
      status: 'canon',
      source_id: source.id,
    });

    supersedeClaim(db, old.id, replacement.id);

    const all = findClaims(db, { entityId: entity.id, attribute: 'wound_location' });
    expect(all).toHaveLength(2);

    const superseded = all.find((c) => c.id === old.id);
    expect(superseded?.status).toBe('superseded');
    expect(superseded?.superseded_by).toBe(replacement.id);

    const canon = findClaims(db, {
      entityId: entity.id,
      attribute: 'wound_location',
      status: 'canon',
    });
    expect(canon).toHaveLength(1);
    expect(canon[0]?.value).toBe('leg');
  });

  it('will not let a claim supersede itself', () => {
    const { entity, source } = seed(db);
    const claim = insertClaim(db, {
      entity_id: entity.id,
      attribute: 'x',
      value: 'y',
      modality: 'asserted',
      status: 'canon',
      source_id: source.id,
    });
    expect(() => supersedeClaim(db, claim.id, claim.id)).toThrow(/supersede itself/);
  });
});

describe('defaults', () => {
  it('puts new claims on the main branch at full confidence', () => {
    const { entity, source } = seed(db);
    const claim = insertClaim(db, {
      entity_id: entity.id,
      attribute: 'nationality',
      value: 'English',
      modality: 'asserted',
      status: 'canon',
      source_id: source.id,
    });
    expect(claim.branch).toBe('main');
    expect(claim.confidence).toBe(1);
    expect(claim.superseded_by).toBeNull();
  });
});

describe('upserts', () => {
  it('reuses an existing work by title', () => {
    const a = upsertWork(db, { title: 'The Red-Headed League' });
    const b = upsertWork(db, { title: 'The Red-Headed League' });
    expect(b.id).toBe(a.id);
  });

  it('matches entities case-insensitively', () => {
    const a = upsertEntity(db, { name: 'Sherlock Holmes', kind: 'character' });
    const b = upsertEntity(db, { name: 'sherlock holmes', kind: 'character' });
    expect(b.id).toBe(a.id);
  });
});

describe('entity lookup by name or alias', () => {
  it('finds an entity through a recorded alias', () => {
    const holmes = insertEntity(db, {
      name: 'Sherlock Holmes',
      kind: 'character',
      aliases: ['Holmes'],
    });
    addEntityAliases(db, holmes.id, ['my friend Holmes']);

    expect(findEntityByNameOrAlias(db, 'Holmes', 'character')?.id).toBe(holmes.id);
    expect(findEntityByNameOrAlias(db, 'my friend Holmes')?.id).toBe(holmes.id);
    expect(findEntityByNameOrAlias(db, 'SHERLOCK HOLMES')?.id).toBe(holmes.id);
    expect(findEntityByNameOrAlias(db, 'Mycroft')).toBeUndefined();
  });

  it('lists entities filtered by kind', () => {
    insertEntity(db, { name: 'Baker Street', kind: 'place' });
    insertEntity(db, { name: 'Sherlock Holmes', kind: 'character' });
    expect(listEntities(db, 'character')).toHaveLength(1);
    expect(listEntities(db)).toHaveLength(2);
  });

  it('promotes and rejects claims via setClaimStatus', () => {
    const { entity, source } = seed(db);
    const claim = insertClaim(db, {
      entity_id: entity.id,
      attribute: 'nationality',
      value: 'English',
      modality: 'asserted',
      status: 'proposed',
      source_id: source.id,
    });
    setClaimStatus(db, claim.id, 'canon');
    expect(findClaims(db, { status: 'canon' })).toHaveLength(1);
    setClaimStatus(db, claim.id, 'rejected');
    expect(findClaims(db, { status: 'rejected' })).toHaveLength(1);
  });
});

describe('cited claims', () => {
  it('always join back to a real excerpt', () => {
    const { entity, source } = seed(db);
    insertClaim(db, {
      entity_id: entity.id,
      attribute: 'nationality',
      value: 'English',
      modality: 'asserted',
      status: 'canon',
      source_id: source.id,
    });
    const cited = findCitedClaims(db, { status: 'canon' });
    expect(cited).toHaveLength(1);
    expect(cited[0]?.entity_name).toBe('John Watson');
    expect(cited[0]?.work_title).toBe('A Study in Scarlet');
    expect(cited[0]?.locator).toBe('ch. 1');
    expect(cited[0]?.text_excerpt.length).toBeGreaterThan(0);
  });
});

describe('stats', () => {
  it('counts an empty database as empty', () => {
    const stats = getStats(db);
    expect(stats.works).toBe(0);
    expect(stats.claims).toBe(0);
    expect(stats.topEntities).toEqual([]);
    expect(stats.lastRunAt).toBeNull();
  });

  it('reflects seeded content', () => {
    const { entity, source } = seed(db);
    insertClaim(db, {
      entity_id: entity.id,
      attribute: 'nationality',
      value: 'English',
      modality: 'asserted',
      status: 'canon',
      source_id: source.id,
    });
    insertClaim(db, {
      entity_id: entity.id,
      attribute: 'occupation',
      value: 'army doctor',
      modality: 'reported',
      status: 'proposed',
      source_id: source.id,
    });
    const run = insertRun(db, {
      kind: 'ingest',
      target: 'study.txt',
      model: 'mock-model',
    });
    insertConflict(db, {
      run_id: run.id,
      draft_claim: { attribute: 'wound_location', value: 'leg' },
      kind: 'contradiction',
      severity: 'high',
      explanation: 'Canon says shoulder.',
    });

    const stats = getStats(db);
    expect(stats.works).toBe(1);
    expect(stats.entities).toBe(1);
    expect(stats.claims).toBe(2);
    expect(stats.claimsByStatus).toEqual({ canon: 1, proposed: 1 });
    expect(stats.claimsByModality).toEqual({ asserted: 1, reported: 1 });
    expect(stats.runs).toBe(1);
    expect(stats.conflicts).toBe(1);
    expect(stats.topEntities[0]).toMatchObject({ name: 'John Watson', claims: 1 });
    expect(stats.lastRunAt).not.toBeNull();
  });
});
