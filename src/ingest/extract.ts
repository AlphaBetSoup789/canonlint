import { z } from 'zod';
import {
  ENTITY_KINDS,
  MODALITIES,
  SUBJECT_SPECIFICITIES,
  type EntityKind,
  type Modality,
  type SubjectSpecificity,
} from '../db/types.js';
import { buildUntrustedPrompt } from '../llm/untrusted.js';
import type { LlmProvider, TokenUsage } from '../llm/types.js';
import { ZERO_USAGE, addUsage } from '../llm/types.js';
import type { TextChunk } from './chunk.js';

export const ExtractedClaimSchema = z.object({
  entity_name: z.string().min(1),
  entity_kind: z.enum(ENTITY_KINDS as unknown as [EntityKind, ...EntityKind[]]),
  entity_aliases: z.array(z.string()).default([]),
  /**
   * How specifically the subject is named. Defaults to `named` so pre-M3.5
   * claim JSON and fixtures keep parsing.
   */
  subject_specificity: z
    .enum(SUBJECT_SPECIFICITIES as unknown as [SubjectSpecificity, ...SubjectSpecificity[]])
    .default('named'),
  attribute: z.string().min(1),
  value: z.string().min(1),
  modality: z.enum(MODALITIES as unknown as [Modality, ...Modality[]]),
  confidence: z.number().min(0).max(1),
  evidence_quote: z.string().min(1),
  valid_from: z.string().nullable().optional().default(null),
  valid_until: z.string().nullable().optional().default(null),
});

export const ExtractResponseSchema = z.object({
  claims: z.array(ExtractedClaimSchema).default([]),
});

export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;

/** JSON Schema handed to providers that enforce structured output. */
export const EXTRACT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'entity_name',
          'entity_kind',
          'entity_aliases',
          'subject_specificity',
          'attribute',
          'value',
          'modality',
          'confidence',
          'evidence_quote',
        ],
        properties: {
          entity_name: { type: 'string', minLength: 1 },
          entity_kind: { type: 'string', enum: [...ENTITY_KINDS] },
          entity_aliases: { type: 'array', items: { type: 'string' } },
          subject_specificity: {
            type: 'string',
            enum: [...SUBJECT_SPECIFICITIES],
          },
          attribute: { type: 'string', minLength: 1 },
          value: { type: 'string', minLength: 1 },
          modality: { type: 'string', enum: [...MODALITIES] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence_quote: { type: 'string', minLength: 1 },
          valid_from: { type: ['string', 'null'] },
          valid_until: { type: ['string', 'null'] },
        },
      },
    },
  },
};

export const EXTRACT_INSTRUCTIONS = [
  'You extract continuity claims from a passage of fiction.',
  '',
  'Return JSON with a "claims" array. Each claim is one established fact about',
  'an entity (character, place, object, faction, or event).',
  '',
  'Rules:',
  '- Only extract facts the text actually establishes. Do not invent.',
  '- evidence_quote MUST be a verbatim substring of the passage.',
  '- Prefer concrete attributes (occupation, appearance, location, relationship,',
  '  possession, timeline anchors) over vague impressions.',
  '- subject_specificity (mandatory):',
  '  named = a proper name appears (e.g. "Sherlock Holmes", "Mary Morstan",',
  '          "Baker Street"). Use the proper name as entity_name.',
  '  definite_description = a unique-in-context description without a proper',
  '          name (e.g. "the red-headed client", "Pondicherry Lodge" when only',
  '          described). Prefer dropping if you cannot name them.',
  '  generic = "a man", "the fellow", "our visitor", "the house", "someone".',
  '          Still emit the claim with specificity=generic so the pipeline can',
  '          drop it — do NOT invent a proper name for them.',
  '- First-person / dialogue (mandatory):',
  '  Track who is speaking. Bind "I" / "my" / "we" / "our" to that speaker\'s',
  '  proper name as entity_name (subject_specificity=named).',
  '  If the speaker cannot be determined with confidence, DROP the claim —',
  '  never default first-person possessives to the narrator.',
  '  Example: in quoted dialogue, Turner saying "my wife died young" is a claim',
  '  about Turner\'s wife, not Watson\'s.',
  '- modality:',
  '  asserted = narration or a reliable statement presented as fact',
  '  believed = a character believes it; may be wrong',
  '  reported = secondhand / hearsay / newspaper',
  '  vision_or_dream = dream, hallucination, prophecy',
  '  lie = stated by a character known (in this passage) to be lying',
  '  figurative = idiom or metaphor not meant literally',
  '    (e.g. "the bird has flown" meaning a person escaped — NOT a claim about',
  '    a bird). Mark figurative rather than extracting a literal reading.',
  '- entity_aliases: other surface forms for the same entity that appear in',
  '  this passage (e.g. "Holmes" when the canonical name is "Sherlock Holmes").',
  '- confidence: 0..1 how sure you are the text supports this claim.',
  '- Skip dialogue-only colour with no durable continuity value.',
  '- Output ONLY valid JSON matching the schema. No prose outside JSON.',
].join('\n');

export interface ExtractResult {
  claims: ExtractedClaim[];
  usage: TokenUsage;
  /** Claims dropped because evidence_quote was not in the chunk. */
  droppedUnprovenanced: number;
  refused: boolean;
  parseError?: string;
}

/**
 * True when `quote` appears in `haystack`, allowing soft whitespace collapse.
 */
export function evidenceInChunk(quote: string, haystack: string): boolean {
  if (quote.trim() === '') return false;
  if (haystack.includes(quote)) return true;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(haystack).includes(norm(quote));
}

export function filterProvenancedClaims(
  claims: ExtractedClaim[],
  chunkText: string,
): { kept: ExtractedClaim[]; dropped: number } {
  const kept: ExtractedClaim[] = [];
  let dropped = 0;
  for (const claim of claims) {
    if (evidenceInChunk(claim.evidence_quote, chunkText)) {
      kept.push(claim);
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

function parseExtractJson(text: string): ExtractedClaim[] {
  const trimmed = text.trim();
  // Tolerate accidental markdown fences from weaker local models.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const raw: unknown = JSON.parse(unfenced);
  const parsed = ExtractResponseSchema.parse(raw);
  return parsed.claims;
}

/**
 * Extract claims from one chunk. Corpus text never enters the system prompt.
 */
export async function extractClaimsFromChunk(
  provider: LlmProvider,
  chunk: TextChunk,
): Promise<ExtractResult> {
  const { system, user } = buildUntrustedPrompt({
    instructions: EXTRACT_INSTRUCTIONS,
    text: chunk.text,
    label: chunk.label,
    question: 'Extract continuity claims from the passage above. Return JSON only.',
  });

  const completion = await provider.complete({
    system,
    user,
    jsonSchema: EXTRACT_JSON_SCHEMA,
  });

  const usage = completion.usage ?? ZERO_USAGE;

  if (completion.refused) {
    return {
      claims: [],
      usage,
      droppedUnprovenanced: 0,
      refused: true,
    };
  }

  try {
    const rawClaims = parseExtractJson(completion.text);
    const { kept, dropped } = filterProvenancedClaims(rawClaims, chunk.text);
    return {
      claims: kept,
      usage,
      droppedUnprovenanced: dropped,
      refused: false,
    };
  } catch (err) {
    return {
      claims: [],
      usage,
      droppedUnprovenanced: 0,
      refused: false,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function extractClaimsFromChunks(
  provider: LlmProvider,
  chunks: TextChunk[],
  onChunk?: (info: {
    chunk: TextChunk;
    result: ExtractResult;
    index: number;
    total: number;
  }) => void,
): Promise<{
  claims: (ExtractedClaim & { locator: string })[];
  usage: TokenUsage;
  warnings: string[];
}> {
  let usage = ZERO_USAGE;
  const claims: (ExtractedClaim & { locator: string })[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const result = await extractClaimsFromChunk(provider, chunk);
    usage = addUsage(usage, result.usage);
    onChunk?.({ chunk, result, index: i, total: chunks.length });

    if (result.refused) {
      warnings.push(`Chunk "${chunk.label}": model refused; skipped.`);
      continue;
    }
    if (result.parseError) {
      warnings.push(
        `Chunk "${chunk.label}": could not parse extraction (${result.parseError}); skipped.`,
      );
      continue;
    }
    if (result.droppedUnprovenanced > 0) {
      warnings.push(
        `Chunk "${chunk.label}": dropped ${result.droppedUnprovenanced} claim(s) with evidence not found in the text.`,
      );
    }
    for (const claim of result.claims) {
      claims.push({ ...claim, locator: chunk.label });
    }
  }

  return { claims, usage, warnings };
}
