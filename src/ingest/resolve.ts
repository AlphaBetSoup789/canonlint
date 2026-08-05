import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  addEntityAliases,
  entityHasClaimsInWork,
  findEntity,
  findEntityByNameOrAlias,
  getEntityAliases,
  insertEntity,
  listEntities,
  listEntitiesInWork,
} from '../db/repo.js';
import type { Entity, EntityKind, SubjectSpecificity } from '../db/types.js';
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
  'Candidates have ALREADY been filtered to share a name token with the',
  'surface. Your job is only to disambiguate among them (or say new).',
  '',
  'Rules:',
  '- Never match on description similarity alone — candidates without a name',
  '  token in common are not in this list for a reason.',
  '- Shared given name alone is not identity: "Mary Morstan" and "Mary Holder"',
  '  are different people.',
  '- Match nicknames and shortened surnames only when they clearly refer to',
  '  the same person (e.g. "Holmes" → "Sherlock Holmes").',
  '- When unsure, prefer match "new".',
  '',
  'Return JSON only:',
  '- match: "existing" if it is one of the candidates, else "new"',
  '- entity_id: required when match is "existing" — must be a candidate id',
  '- canonical_name: preferred display name when match is "new"',
  '- aliases: other surface forms to record',
].join('\n');

/** Articles / titles stripped before name-token comparison. */
const NAME_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'my',
  'our',
  'his',
  'her',
  'their',
  'its',
  'mr',
  'mrs',
  'miss',
  'ms',
  'dr',
  'sir',
  'lord',
  'lady',
]);

export interface ResolveInput {
  name: string;
  kind: EntityKind;
  aliases?: string[];
  /**
   * How specifically the subject is named. Only `named` may merge across
   * works. Defaults to `named` for back-compat with pre-M3.5 claim JSON.
   */
  subjectSpecificity?: SubjectSpecificity;
  /**
   * Current work id. Required to scope non-`named` resolution; when absent,
   * non-`named` subjects never match existing entities (create/drop only).
   */
  workId?: number;
  /** Used to disambiguate entity names when a global UNIQUE collision occurs. */
  workTitle?: string;
  /**
   * When false (check pipeline), never insert a new entity — return
   * `entity: undefined` if nothing in the DB matches.
   * Default true for ingest.
   */
  createIfMissing?: boolean;
  /**
   * When false (check pipeline), never write alias updates to an existing
   * entity — resolution is read-only. Default true for ingest, where
   * accumulating aliases across a corpus is the point.
   */
  mutate?: boolean;
}

export interface ResolveResult {
  entity: Entity | undefined;
  usage: TokenUsage;
  /** True when the LLM was asked to adjudicate. */
  llmUsed: boolean;
  /** True when a generic subject was dropped rather than stored. */
  dropped?: boolean;
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

/** Significant name tokens for matching (exported for tests). */
export function significantNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/[\s'-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !NAME_STOPWORDS.has(t));
}

function isContiguousSubsequence(shorter: string[], longer: string[]): boolean {
  if (shorter.length === 0) return false;
  if (shorter.length > longer.length) return false;
  for (let i = 0; i <= longer.length - shorter.length; i++) {
    let ok = true;
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] !== shorter[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Whether two surface forms share enough name tokens to be merge-eligible.
 *
 * Description similarity is intentionally ignored — this is the M3.5 gate
 * that stops "a man" → Achmet and "Mary Morstan" → "Mary Holder".
 */
export function isNameTokenMatch(
  surface: string,
  candidateName: string,
  candidateAliases: string[] = [],
): boolean {
  const forms = [candidateName, ...candidateAliases];
  for (const form of forms) {
    if (surface.trim().toLowerCase() === form.trim().toLowerCase()) return true;
    if (tokensMatch(surface, form)) return true;
  }
  return false;
}

function tokensMatch(a: string, b: string): boolean {
  const ta = significantNameTokens(a);
  const tb = significantNameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta.join('\0') === tb.join('\0')) return true;

  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];

  if (isContiguousSubsequence(shorter, longer)) {
    // Single-token hit: only surname/short-form (last token of the longer name).
    // Blocks given-name-only merges: "Mary" ↛ "Mary Morstan".
    if (shorter.length === 1) {
      return longer[longer.length - 1] === shorter[0];
    }
    // Multi-token phrase contained (e.g. "Baker Street" ⊂ "221B Baker Street").
    return true;
  }

  // Two full names that share only a given name must not merge.
  if (
    ta.length >= 2 &&
    tb.length >= 2 &&
    ta[0] === tb[0] &&
    ta.slice(1).join('\0') !== tb.slice(1).join('\0')
  ) {
    return false;
  }

  return false;
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

function filterByNameToken(
  surface: string,
  surfaceAliases: string[],
  candidates: Entity[],
): Entity[] {
  return candidates.filter((c) => {
    const aliases = getEntityAliases(c);
    if (isNameTokenMatch(surface, c.name, aliases)) return true;
    return surfaceAliases.some((a) => isNameTokenMatch(a, c.name, aliases));
  });
}

function inWorkScope(
  db: Db,
  entity: Entity,
  specificity: SubjectSpecificity,
  workId: number | undefined,
): boolean {
  if (specificity === 'named') return true;
  if (workId === undefined) return false;
  return entityHasClaimsInWork(db, entity.id, workId);
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

function hitResult(
  db: Db,
  entity: Entity,
  kind: EntityKind,
  surfaceAliases: string[],
  mutate: boolean,
  llmUsed: boolean,
): ResolveResult {
  if (mutate) {
    addEntityAliases(
      db,
      entity.id,
      surfaceAliases.filter((a) => a.toLowerCase() !== entity.name.toLowerCase()),
    );
  }
  return {
    entity: mutate
      ? (findEntityByNameOrAlias(db, entity.name, kind) ?? entity)
      : entity,
    usage: ZERO_USAGE,
    llmUsed,
  };
}

function createEntity(
  db: Db,
  input: ResolveInput,
  surfaceAliases: string[],
  canonicalName: string,
  extraAliases: string[] = [],
): Entity {
  let name = canonicalName.trim() || input.name;
  const existing = findEntity(db, name, input.kind);
  if (existing) {
    // UNIQUE(name, kind) collision with an out-of-scope entity — namespace it.
    const suffix = input.workTitle?.trim() || `work-${input.workId ?? 'unknown'}`;
    name = `${name} (${suffix})`;
  }
  return insertEntity(db, {
    name,
    kind: input.kind,
    aliases: uniqueAliases(
      extraAliases,
      surfaceAliases.filter((a) => a.toLowerCase() !== name.toLowerCase()),
    ),
  });
}

/**
 * Resolve a surface name to a stored entity, merging aliases on hit.
 *
 * Order: exact/alias (scope-aware) → name-token-filtered LLM → insert/drop.
 * Description similarity never creates a match on its own (M3.5).
 */
export async function resolveEntity(
  db: Db,
  provider: LlmProvider,
  input: ResolveInput,
): Promise<ResolveResult> {
  let usage = ZERO_USAGE;
  const surfaceAliases = uniqueAliases(input.aliases, [input.name]);
  const mutate = input.mutate !== false;
  const createIfMissing = input.createIfMissing !== false;
  const specificity: SubjectSpecificity = input.subjectSpecificity ?? 'named';

  // Generics are too weak to ground continuity — drop rather than magnetize.
  if (specificity === 'generic') {
    return { entity: undefined, usage, llmUsed: false, dropped: true };
  }

  const tryHit = (entity: Entity | undefined): ResolveResult | undefined => {
    if (!entity) return undefined;
    if (!inWorkScope(db, entity, specificity, input.workId)) return undefined;
    return hitResult(db, entity, input.kind, surfaceAliases, mutate, false);
  };

  const exactHit = tryHit(findEntity(db, input.name, input.kind));
  if (exactHit) return exactHit;

  const aliasHit = tryHit(findEntityByNameOrAlias(db, input.name, input.kind));
  if (aliasHit) return aliasHit;

  for (const alias of input.aliases ?? []) {
    const hit = tryHit(findEntityByNameOrAlias(db, alias, input.kind));
    if (hit) return hit;
  }

  // Candidate pool: named → global same-kind; definite_description → this work only.
  let pool: Entity[];
  if (specificity === 'definite_description') {
    pool =
      input.workId !== undefined
        ? listEntitiesInWork(db, input.workId, input.kind)
        : [];
  } else {
    const sameKind = listEntities(db, input.kind);
    pool =
      sameKind.length > 0
        ? sameKind
        : listEntities(db).length <= 40
          ? listEntities(db)
          : [];
  }

  // Name-token gate: description similarity may only disambiguate, never create.
  const candidates = filterByNameToken(input.name, surfaceAliases, pool);

  if (candidates.length === 0) {
    if (!createIfMissing) {
      return { entity: undefined, usage, llmUsed: false };
    }
    const entity = createEntity(db, input, surfaceAliases, input.name);
    return { entity, usage, llmUsed: false };
  }

  const { decision, usage: resolveUsage } = await llmResolve(
    provider,
    input,
    candidates,
  );
  usage = addUsage(usage, resolveUsage);

  if (decision.match === 'existing' && decision.entity_id !== undefined) {
    const existing = candidates.find((c) => c.id === decision.entity_id);
    if (existing) {
      // Belt-and-braces: refuse LLM merges that somehow lack a name token.
      if (
        !isNameTokenMatch(input.name, existing.name, getEntityAliases(existing)) &&
        !(input.aliases ?? []).some((a) =>
          isNameTokenMatch(a, existing.name, getEntityAliases(existing)),
        )
      ) {
        // Fall through to create/undefined.
      } else {
        if (mutate) {
          addEntityAliases(
            db,
            existing.id,
            uniqueAliases(
              decision.aliases,
              surfaceAliases.filter(
                (a) => a.toLowerCase() !== existing.name.toLowerCase(),
              ),
            ),
          );
        }
        return {
          entity: mutate
            ? (findEntityByNameOrAlias(db, existing.name, existing.kind) ??
              existing)
            : existing,
          usage,
          llmUsed: true,
        };
      }
    }
  }

  if (!createIfMissing) {
    return { entity: undefined, usage, llmUsed: true };
  }

  const canonical = (decision.canonical_name ?? input.name).trim() || input.name;
  const entity = createEntity(
    db,
    input,
    surfaceAliases,
    canonical,
    decision.aliases ?? [],
  );
  return { entity, usage, llmUsed: true };
}
