import { z } from 'zod';
import type { CitedClaim } from '../db/repo.js';
import type { ConflictKind, Severity } from '../db/types.js';
import type { ExtractedClaim } from '../ingest/extract.js';
import { buildUntrustedPrompt } from '../llm/untrusted.js';
import type { LlmProvider, TokenUsage } from '../llm/types.js';
import { ZERO_USAGE } from '../llm/types.js';

export const ADJUDICATION_VERDICTS = [
  'contradiction',
  'consistent',
  'new_fact',
  'timeline',
  'needs_human',
] as const;

export type AdjudicationVerdict = (typeof ADJUDICATION_VERDICTS)[number];

const AdjudicationSchema = z.object({
  verdict: z.enum(ADJUDICATION_VERDICTS),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  explanation: z.string().min(1),
  /** Required when verdict is contradiction or timeline. */
  canon_claim_id: z.number().int().positive().nullable().optional(),
  summary: z.string().min(1).optional(),
});

export type Adjudication = z.infer<typeof AdjudicationSchema>;

export const ADJUDICATE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'severity', 'explanation'],
  properties: {
    verdict: { type: 'string', enum: [...ADJUDICATION_VERDICTS] },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    explanation: { type: 'string', minLength: 1 },
    canon_claim_id: { type: ['integer', 'null'] },
    summary: { type: 'string' },
  },
};

export const ADJUDICATE_INSTRUCTIONS = [
  'You adjudicate whether a draft claim contradicts established canon.',
  '',
  'You are given one draft claim and zero or more candidate canon claims',
  'for the same entity. Decide the relationship.',
  '',
  'Verdicts:',
  '- contradiction: the draft asserts something incompatible with a canon claim',
  '- timeline: the draft breaks an in-universe time/order constraint in canon',
  '- new_fact: compatible with canon and adds something not already recorded',
  '- consistent: restates or is compatible with canon; no issue to report',
  '- needs_human: you cannot decide with confidence — never guess a contradiction',
  '',
  'Precision rules (mandatory):',
  '- Only return contradiction or timeline if you can cite a specific candidate',
  "  by canon_claim_id AND that candidate's excerpt supports the conflict.",
  '- If unsure, return needs_human. A false contradiction is worse than a miss.',
  '- Modalities matter: a believed/reported/lie claim in canon is weaker ground',
  '  for contradiction than an asserted fact.',
  '- Output JSON only.',
].join('\n');

export interface AdjudicateInput {
  draftClaim: ExtractedClaim & { locator: string };
  entityName: string;
  candidates: CitedClaim[];
}

export interface AdjudicateResult {
  adjudication: Adjudication;
  usage: TokenUsage;
  refused: boolean;
  parseError?: string;
}

function candidatePayload(candidates: CitedClaim[]): string {
  if (candidates.length === 0) return '(no canon candidates for this entity)';
  return candidates
    .map(
      (c) =>
        `- id=${c.id} attr=${JSON.stringify(c.attribute)} value=${JSON.stringify(c.value)} ` +
        `modality=${c.modality} work=${JSON.stringify(c.work_title)} ` +
        `locator=${JSON.stringify(c.locator)} excerpt=${JSON.stringify(c.text_excerpt)}`,
    )
    .join('\n');
}

function parseAdjudication(text: string): Adjudication {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return AdjudicationSchema.parse(JSON.parse(trimmed));
}

/**
 * Enforce precision: contradiction/timeline without a valid cited canon claim
 * are downgraded to needs_human.
 */
export function enforcePrecision(
  adjudication: Adjudication,
  candidates: CitedClaim[],
): Adjudication {
  if (adjudication.verdict !== 'contradiction' && adjudication.verdict !== 'timeline') {
    return adjudication;
  }
  const id = adjudication.canon_claim_id;
  const hit =
    id !== undefined && id !== null ? candidates.find((c) => c.id === id) : undefined;
  if (!hit || !hit.text_excerpt.trim()) {
    return {
      ...adjudication,
      verdict: 'needs_human',
      explanation:
        adjudication.explanation +
        ' [downgraded: contradiction/timeline requires a cited canon excerpt]',
      canon_claim_id: null,
    };
  }
  return adjudication;
}

/** Map LLM verdict onto ConflictKind; consistent is not persisted. */
export function toConflictKind(verdict: AdjudicationVerdict): ConflictKind | null {
  switch (verdict) {
    case 'contradiction':
      return 'contradiction';
    case 'timeline':
      return 'timeline';
    case 'new_fact':
      return 'new_fact';
    case 'needs_human':
      return 'uncertain';
    case 'consistent':
      return null;
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
}

export function defaultSummary(draft: ExtractedClaim, entityName: string): string {
  return `${entityName}'s ${draft.attribute} is ${draft.value}.`;
}

export async function adjudicateClaim(
  provider: LlmProvider,
  input: AdjudicateInput,
): Promise<AdjudicateResult> {
  const payload = [
    `Entity: ${input.entityName}`,
    '',
    'Draft claim:',
    JSON.stringify(
      {
        attribute: input.draftClaim.attribute,
        value: input.draftClaim.value,
        modality: input.draftClaim.modality,
        confidence: input.draftClaim.confidence,
        locator: input.draftClaim.locator,
        evidence_quote: input.draftClaim.evidence_quote,
      },
      null,
      2,
    ),
    '',
    'Canon candidates:',
    candidatePayload(input.candidates),
  ].join('\n');

  const { system, user } = buildUntrustedPrompt({
    instructions: ADJUDICATE_INSTRUCTIONS,
    text: payload,
    label: `draft claim @ ${input.draftClaim.locator}`,
    question: 'Adjudicate the draft claim against the candidates. JSON only.',
  });

  const completion = await provider.complete({
    system,
    user,
    jsonSchema: ADJUDICATE_JSON_SCHEMA,
    maxTokens: 1024,
  });

  const usage = completion.usage ?? ZERO_USAGE;
  if (completion.refused) {
    return {
      adjudication: {
        verdict: 'needs_human',
        severity: 'medium' as Severity,
        explanation: 'Model refused to adjudicate.',
        canon_claim_id: null,
      },
      usage,
      refused: true,
    };
  }

  try {
    const raw = parseAdjudication(completion.text);
    const adjudication = enforcePrecision(raw, input.candidates);
    return { adjudication, usage, refused: false };
  } catch (err) {
    return {
      adjudication: {
        verdict: 'needs_human',
        severity: 'medium',
        explanation: 'Could not parse adjudication response.',
        canon_claim_id: null,
      },
      usage,
      refused: false,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}
