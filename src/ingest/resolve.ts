import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  addEntityAliases,
  findEntity,
  findEntityByNameOrAlias,
  getEntityAliases,
  insertEntity,
  listEntities,
} from '../db/repo.js';
import type { Entity, EntityKind } from '../db/types.js';
import { buildUntrustedPrompt } from '../llm/untrusted.js';
import type { LlmProvider, TokenUsage } from '../llm/types.js';
import { ZERO_USAGE, addUsage } from '../llm/types.js';

const ResolveResponseSchema = z.object({
  match: z.enum(['existing', 'new']),
  entity_id: z.number().int().positive().optional(),
  canonical_name: z.string().min(1).optional(),
  aliases: z.array(z.string()).default([]),
});

export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;

export const RESOLVE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['match'],
  properties: {
    match: { type: 'string', enum: ['existing', 'new'] },
    entity_id: { type: 'integer', minimum: 1 },
    canonical_name: { type: 'string', minLength: 1 },
    aliases: { type: 'array', items: { type: 'string' } },
  },
};

const RESOLVE_INSTRUCTIONS = [
  'You resolve a named entity from fiction against a candidate list.',
  '',
  'Decide whether the surface name refers to an existing candidate or is new.',
  'Match nicknames, shortened forms, and epithets to the same person/place',
  '(e.g. "Holmes", "Sherlock Holmes", and "my friend Holmes" are one entity).',
  '',
  'Return JSON only:',
  '- match: "existing" if it is one of the candidates, else "new"',
  '- entity_id: required when match is "existing" — must be a candidate id',
  '- canonical_name: preferred display name when match is "new"',
  '- aliases: other surface forms to record',
  '',
  'Do not invent entities that are not implied by the surface name.',
  'When unsure between two candidates, prefer match "new" rather than guessing.',
].join('\n');

export interface ResolveInput {
  name: string;
  kind: EntityKind;
  aliases?: string[];
  /**
   * When false (check pipeline), never insert a new entity — return
   * `entity: undefined` if nothing in the DB matches.
   * Default true for ingest.
   */
  createIfMissing?: boolean;
}

export interface ResolveResult {
  entity: Entity | undefined;
  usage: TokenUsage;
  /** True when the LLM was asked to adjudicate. */
  llmUsed: boolean;
}

function uniqueAliases(...lists: (string[] | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const alias = raw.trim();
      if (alias === '') continue;
      const key = alias.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(alias);
    }
  }
  return out;
}

function candidateBlock(candidates: Entity[]): string {
  if (candidates.length === 0) {
    return '(no existing candidates)';
  }
  return candidates
    .map((c) => {
      const aliases = getEntityAliases(c);
      const aliasPart = aliases.length > 0 ? `; aliases: ${aliases.join(', ')}` : '';
      return `- id=${c.id} name=${JSON.stringify(c.name)} kind=${c.kind}${aliasPart}`;
    })
    .join('\n');
}

async function llmResolve(
  provider: LlmProvider,
  input: ResolveInput,
  candidates: Entity[],
): Promise<{ decision: ResolveResponse; usage: TokenUsage }> {
  const payload = [
    `Surface name: ${input.name}`,
    `Kind: ${input.kind}`,
    input.aliases && input.aliases.length > 0
      ? `Suggested aliases: ${input.aliases.join(', ')}`
      : null,
    '',
    'Candidates:',
    candidateBlock(candidates),
  ]
    .filter((line) => line !== null)
    .join('\n');

  const { system, user } = buildUntrustedPrompt({
    instructions: RESOLVE_INSTRUCTIONS,
    text: payload,
    label: 'entity resolution candidates',
    question: 'Resolve the surface name against the candidates. JSON only.',
  });

  const completion = await provider.complete({
    system,
    user,
    jsonSchema: RESOLVE_JSON_SCHEMA,
    maxTokens: 512,
  });

  if (completion.refused) {
    return {
      decision: { match: 'new', canonical_name: input.name, aliases: [] },
      usage: completion.usage,
    };
  }

  try {
    const trimmed = completion.text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const decision = ResolveResponseSchema.parse(JSON.parse(trimmed));
    if (decision.match === 'existing') {
      const id = decision.entity_id;
      if (id === undefined || !candidates.some((c) => c.id === id)) {
        return {
          decision: { match: 'new', canonical_name: input.name, aliases: [] },
          usage: completion.usage,
        };
      }
    }
    return { decision, usage: completion.usage };
  } catch {
    return {
      decision: { match: 'new', canonical_name: input.name, aliases: [] },
      usage: completion.usage,
    };
  }
}

/**
 * Resolve a surface name to a stored entity, merging aliases on hit.
 *
 * Order: exact name → alias → LLM adjudication against candidates → insert.
 */
export async function resolveEntity(
  db: Db,
  provider: LlmProvider,
  input: ResolveInput,
): Promise<ResolveResult> {
  let usage = ZERO_USAGE;
  const surfaceAliases = uniqueAliases(input.aliases, [input.name]);

  const exact = findEntity(db, input.name, input.kind);
  if (exact) {
    addEntityAliases(
      db,
      exact.id,
      surfaceAliases.filter((a) => a.toLowerCase() !== exact.name.toLowerCase()),
    );
    return {
      entity: findEntityByNameOrAlias(db, exact.name, input.kind) ?? exact,
      usage,
      llmUsed: false,
    };
  }

  const byAlias = findEntityByNameOrAlias(db, input.name, input.kind);
  if (byAlias) {
    addEntityAliases(
      db,
      byAlias.id,
      surfaceAliases.filter((a) => a.toLowerCase() !== byAlias.name.toLowerCase()),
    );
    return {
      entity: findEntityByNameOrAlias(db, byAlias.name, input.kind) ?? byAlias,
      usage,
      llmUsed: false,
    };
  }

  // Also try aliases from the extractor against the DB before calling the LLM.
  for (const alias of input.aliases ?? []) {
    const hit = findEntityByNameOrAlias(db, alias, input.kind);
    if (hit) {
      addEntityAliases(
        db,
        hit.id,
        surfaceAliases.filter((a) => a.toLowerCase() !== hit.name.toLowerCase()),
      );
      return {
        entity: findEntityByNameOrAlias(db, hit.name, input.kind) ?? hit,
        usage,
        llmUsed: false,
      };
    }
  }

  const createIfMissing = input.createIfMissing !== false;

  const sameKind = listEntities(db, input.kind);
  const candidates =
    sameKind.length > 0
      ? sameKind
      : listEntities(db).length <= 40
        ? listEntities(db)
        : [];

  if (candidates.length === 0) {
    if (!createIfMissing) {
      return { entity: undefined, usage, llmUsed: false };
    }
    const entity = insertEntity(db, {
      name: input.name,
      kind: input.kind,
      aliases: surfaceAliases.filter(
        (a) => a.toLowerCase() !== input.name.toLowerCase(),
      ),
    });
    return { entity, usage, llmUsed: false };
  }

  const { decision, usage: resolveUsage } = await llmResolve(
    provider,
    input,
    candidates,
  );
  usage = addUsage(usage, resolveUsage);

  if (decision.match === 'existing' && decision.entity_id !== undefined) {
    const existing = candidates.find((c) => c.id === decision.entity_id)!;
    addEntityAliases(
      db,
      existing.id,
      uniqueAliases(
        decision.aliases,
        surfaceAliases.filter((a) => a.toLowerCase() !== existing.name.toLowerCase()),
      ),
    );
    return {
      entity: findEntityByNameOrAlias(db, existing.name, existing.kind) ?? existing,
      usage,
      llmUsed: true,
    };
  }

  if (!createIfMissing) {
    return { entity: undefined, usage, llmUsed: true };
  }

  const canonical = (decision.canonical_name ?? input.name).trim() || input.name;
  const entity = insertEntity(db, {
    name: canonical,
    kind: input.kind,
    aliases: uniqueAliases(
      decision.aliases,
      surfaceAliases.filter((a) => a.toLowerCase() !== canonical.toLowerCase()),
    ),
  });
  return { entity, usage, llmUsed: true };
}
