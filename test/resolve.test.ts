import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import {
  addEntityAliases,
  findEntityByNameOrAlias,
  getEntityAliases,
  insertEntity,
} from '../src/db/repo.js';
import { resolveEntity } from '../src/ingest/resolve.js';
import { MockProvider } from '../src/llm/mock.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
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

  it('asks the LLM when the name is new but candidates exist', async () => {
    insertEntity(db, {
      name: 'Sherlock Holmes',
      kind: 'character',
      aliases: ['Holmes'],
    });
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
    });
    expect(result.llmUsed).toBe(true);
    expect(result.entity?.name).toBe('Sherlock Holmes');
    expect(getEntityAliases(result.entity!)).toContain('the detective');
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

    const result = await resolveEntity(db, provider, {
      name: 'Mycroft',
      kind: 'character',
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
});
