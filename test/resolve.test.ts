import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import {
  addEntityAliases,
  findEntityByNameOrAlias,
  getEntityAliases,
  insertClaim,
  insertEntity,
  insertSource,
  insertWork,
  listEntities,
} from '../src/db/repo.js';
import {
  isNameTokenMatch,
  resolveEntity,
  significantNameTokens,
} from '../src/ingest/resolve.js';
import { MockProvider } from '../src/llm/mock.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('name-token matching', () => {
  it('allows surname short forms and multi-token phrase containment', () => {
    expect(isNameTokenMatch('Holmes', 'Sherlock Holmes')).toBe(true);
    expect(isNameTokenMatch('Watson', 'John Watson')).toBe(true);
    expect(isNameTokenMatch('Baker Street', '221B Baker Street')).toBe(true);
    expect(isNameTokenMatch('Sherlock Holmes', 'Sherlock Holmes')).toBe(true);
  });

  it('rejects given-name-only and cross-surname Mary collisions', () => {
    expect(isNameTokenMatch('Mary', 'Mary Morstan')).toBe(false);
    expect(isNameTokenMatch('Mary Morstan', 'Mary Holder')).toBe(false);
    expect(significantNameTokens('a man')).toEqual(['man']);
    expect(isNameTokenMatch('a man', 'Achmet')).toBe(false);
  });

  it('rejects place collapse across unrelated addresses', () => {
    expect(isNameTokenMatch('221B Baker Street', '3 Lauriston Gardens')).toBe(
      false,
    );
    expect(isNameTokenMatch('Pondicherry Lodge', 'Birlstone Manor')).toBe(false);
  });
});

describe('resolveEntity', () => {
  it('merges Holmes / Sherlock Holmes / my friend Holmes onto one entity', async () => {
    const provider = new MockProvider({
      responder: (req) => {
        if (req.user.includes('entity resolution')) {
          const idMatch = /id=(\d+)/.exec(req.user);
          return JSON.stringify({
            match: 'existing',
            entity_id: Number(idMatch?.[1] ?? 1),
            aliases: ['my friend Holmes'],
          });
        }
        return '{}';
      },
    });

    const first = await resolveEntity(db, provider, {
      name: 'Sherlock Holmes',
      kind: 'character',
      aliases: ['Holmes'],
    });
    expect(first.entity).toBeDefined();
    expect(first.llmUsed).toBe(false);

    const second = await resolveEntity(db, provider, {
      name: 'Holmes',
      kind: 'character',
    });
    expect(second.entity?.id).toBe(first.entity!.id);
    expect(second.llmUsed).toBe(false);

    addEntityAliases(db, first.entity!.id, ['my friend Holmes']);
    const third = await resolveEntity(db, provider, {
      name: 'my friend Holmes',
      kind: 'character',
    });
    expect(third.entity?.id).toBe(first.entity!.id);

    const aliases = getEntityAliases(
      findEntityByNameOrAlias(db, 'Sherlock Holmes', 'character')!,
    );
    expect(aliases.map((a) => a.toLowerCase())).toEqual(
      expect.arrayContaining(['holmes', 'my friend holmes']),
    );

    const all = db.prepare('SELECT COUNT(*) AS n FROM entities').get() as {
      n: number;
    };
    expect(all.n).toBe(1);
  });

  it('does not merge description-only surfaces onto named entities', async () => {
    insertEntity(db, {
      name: 'Sherlock Holmes',
      kind: 'character',
      aliases: ['Holmes'],
    });
    // LLM would happily say "existing" — name-token gate must prevent the call
    // from seeing Holmes as a candidate, so we create new without trusting it.
    const provider = new MockProvider({
      responder: () =>
        JSON.stringify({
          match: 'existing',
          entity_id: 1,
          aliases: ['the detective'],
        }),
    });

    const result = await resolveEntity(db, provider, {
      name: 'the detective',
      kind: 'character',
      subjectSpecificity: 'definite_description',
      workId: 1,
      workTitle: 'A Study in Scarlet',
    });
    expect(result.entity?.name).not.toBe('Sherlock Holmes');
    expect(listEntities(db).length).toBe(2);
  });

  it('creates a new entity when the LLM says new', async () => {
    insertEntity(db, { name: 'Sherlock Holmes', kind: 'character' });
    const provider = new MockProvider({
      responder: () =>
        JSON.stringify({
          match: 'new',
          canonical_name: 'Mycroft Holmes',
          aliases: ['Mycroft'],
        }),
    });

    // "Mycroft" alone is a given-name-style token vs "Sherlock Holmes" —
    // no name-token candidate, so insert without LLM.
    const result = await resolveEntity(db, provider, {
      name: 'Mycroft Holmes',
      kind: 'character',
      aliases: ['Mycroft'],
    });
    expect(result.entity?.name).toBe('Mycroft Holmes');
    expect(result.entity?.id).not.toBe(1);
  });

  it('does not create entities when createIfMissing is false', async () => {
    const provider = new MockProvider();
    const result = await resolveEntity(db, provider, {
      name: 'Nobody',
      kind: 'character',
      createIfMissing: false,
    });
    expect(result.entity).toBeUndefined();
    const all = db.prepare('SELECT COUNT(*) AS n FROM entities').get() as {
      n: number;
    };
    expect(all.n).toBe(0);
  });

  it('drops generic subjects instead of merging them', async () => {
    insertEntity(db, { name: 'Achmet', kind: 'character' });
    const provider = new MockProvider({
      responder: () =>
        JSON.stringify({ match: 'existing', entity_id: 1, aliases: [] }),
    });
    const result = await resolveEntity(db, provider, {
      name: 'a man',
      kind: 'character',
      subjectSpecificity: 'generic',
    });
    expect(result.dropped).toBe(true);
    expect(result.entity).toBeUndefined();
    expect(listEntities(db)).toHaveLength(1);
  });

  it('does not merge Mary Morstan with Mary Holder on given name alone', async () => {
    insertEntity(db, { name: 'Mary Morstan', kind: 'character' });
    const provider = new MockProvider({
      responder: () =>
        JSON.stringify({
          match: 'existing',
          entity_id: 1,
          aliases: [],
        }),
    });
    const result = await resolveEntity(db, provider, {
      name: 'Mary Holder',
      kind: 'character',
      subjectSpecificity: 'named',
    });
    expect(result.entity?.name).toBe('Mary Holder');
    expect(result.entity?.id).not.toBe(1);
  });

  it('scopes definite_description matches to the current work', async () => {
    const sign = insertWork(db, { title: 'The Sign of the Four', order_index: 2 });
    const league = insertWork(db, {
      title: 'The Red-Headed League',
      order_index: 3,
    });
    const achmet = insertEntity(db, { name: 'Achmet', kind: 'character' });
    const src = insertSource(db, {
      work_id: sign.id,
      locator: 'ch. XII',
      text_excerpt: 'the little fat round fellow',
    });
    insertClaim(db, {
      entity_id: achmet.id,
      attribute: 'appearance',
      value: 'little fat round fellow',
      modality: 'asserted',
      status: 'canon',
      source_id: src.id,
    });

    const provider = new MockProvider({
      responder: () =>
        JSON.stringify({ match: 'existing', entity_id: achmet.id, aliases: [] }),
    });

    // Same definite description in a different work must not hit Achmet.
    const result = await resolveEntity(db, provider, {
      name: 'the little fat round fellow',
      kind: 'character',
      subjectSpecificity: 'definite_description',
      workId: league.id,
      workTitle: league.title,
    });
    expect(result.entity?.id).not.toBe(achmet.id);
  });
});
