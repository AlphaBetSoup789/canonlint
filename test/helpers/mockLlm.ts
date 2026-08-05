import { MockProvider } from '../../src/llm/mock.js';
import { miniExtractResponse } from '../fixtures/mini-claims.js';
import type { ExtractedClaim } from '../../src/ingest/extract.js';
import type { LlmProvider, TokenUsage } from '../../src/llm/types.js';

/**
 * Wraps a provider with a non-zero `costOf`, so tests can exercise the
 * running spend-cap check without depending on real Anthropic pricing.
 */
export class CostedProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly enforcesSchema: boolean;
  private readonly inner: LlmProvider;
  private readonly usdPerCall: number;
  calls = 0;

  constructor(inner: LlmProvider, usdPerCall: number) {
    this.inner = inner;
    this.name = inner.name;
    this.model = inner.model;
    this.enforcesSchema = inner.enforcesSchema;
    this.usdPerCall = usdPerCall;
  }

  complete: LlmProvider['complete'] = async (request) => {
    this.calls += 1;
    return this.inner.complete(request);
  };

  costOf(usage: TokenUsage): number {
    // Flat per-call charge regardless of token usage — keeps the test's
    // spend math simple and independent of prompt length.
    void usage;
    return this.calls * this.usdPerCall;
  }
}

/** Shared entity-resolution responder used by ingest + check tests. */
export function resolveResponder(req: { user: string }): string | null {
  if (!req.user.includes('entity resolution')) return null;
  const surface = /Surface name: (.+)/.exec(req.user)?.[1]?.trim() ?? '';
  const idLines = [...req.user.matchAll(/- id=(\d+) name="([^"]+)"/g)];
  const lower = surface.toLowerCase();
  for (const m of idLines) {
    const id = Number(m[1]);
    const name = (m[2] ?? '').toLowerCase();
    const rest = req.user.slice(req.user.indexOf(m[0]));
    const aliases = /aliases: ([^\n]*)/.exec(rest)?.[1]?.toLowerCase() ?? '';
    if (
      name === lower ||
      lower.includes(name) ||
      name.includes(lower) ||
      aliases.includes(lower) ||
      (lower.includes('voss') && name.includes('voss')) ||
      (lower.includes('carr') && name.includes('carr')) ||
      (lower.includes('bramley') && name.includes('bramley')) ||
      (lower.includes('trent') && name.includes('trent')) ||
      (lower.includes('cole') && name.includes('cole')) ||
      (lower.includes('wilde') && name.includes('wilde')) ||
      (lower.includes('amber') && name.includes('amber')) ||
      (lower.includes('harbour') && name.includes('harbour')) ||
      (lower.includes('grey') && name.includes('grey'))
    ) {
      return JSON.stringify({
        match: 'existing',
        entity_id: id,
        aliases: [surface],
      });
    }
  }
  return JSON.stringify({
    match: 'new',
    canonical_name: surface,
    aliases: [],
  });
}

export function mockIngestProvider(): MockProvider {
  return new MockProvider({
    responder: (req) => resolveResponder(req) ?? miniExtractResponse(),
  });
}

/**
 * Check-time mock: extracts the provided claims (filtered by chunk evidence),
 * resolves entities, and adjudicates by comparing draft value to exact-attr
 * canon candidates.
 */
export function mockCheckProvider(draftClaims: ExtractedClaim[]): MockProvider {
  return new MockProvider({
    responder: (req) => {
      const resolved = resolveResponder(req);
      if (resolved) return resolved;

      if (req.user.includes('Adjudicate the draft claim')) {
        return adjudicateFromPayload(req.user);
      }

      // Extraction
      const norm = (s: string) => s.replace(/\s+/g, ' ');
      const kept = draftClaims.filter(
        (c) =>
          req.user.includes(c.evidence_quote) ||
          norm(req.user).includes(norm(c.evidence_quote)),
      );
      return JSON.stringify({ claims: kept });
    },
  });
}

function adjudicateFromPayload(user: string): string {
  const draftMatch = /"attribute": "([^"]+)"[\s\S]*?"value": "([^"]+)"/.exec(user);
  const draftAttr = draftMatch?.[1] ?? '';
  const draftValue = (draftMatch?.[2] ?? '').toLowerCase();

  // Only exact-attribute candidates can ground a contradiction. Related
  // (other-attribute) rows are context — absence of an exact match is a new fact.
  const lines = [...user.matchAll(/- id=(\d+) attr="([^"]+)" value="([^"]+)"/g)];
  const exact = lines.filter(
    (m) => (m[2] ?? '').toLowerCase() === draftAttr.toLowerCase(),
  );

  if (exact.length === 0) {
    return JSON.stringify({
      verdict: 'new_fact',
      severity: 'low',
      explanation: 'No canon claim for this attribute; new fact.',
      summary: `${draftAttr} = ${draftMatch?.[2] ?? ''}`,
      same_entity_confidence: 1,
    });
  }

  for (const m of exact) {
    const id = Number(m[1]);
    const canonValue = (m[3] ?? '').toLowerCase();
    if (canonValue === draftValue) {
      return JSON.stringify({
        verdict: 'consistent',
        severity: 'low',
        explanation: 'Restates canon.',
        canon_claim_id: id,
        same_entity_confidence: 1,
      });
    }
    // Soft match: one contains the other (e.g. residence phrasing).
    if (canonValue.includes(draftValue) || draftValue.includes(canonValue)) {
      return JSON.stringify({
        verdict: 'consistent',
        severity: 'low',
        explanation: 'Compatible with canon.',
        canon_claim_id: id,
        same_entity_confidence: 1,
      });
    }
  }

  const hit = exact[0]!;
  return JSON.stringify({
    verdict: 'contradiction',
    severity: 'high',
    explanation: `Draft says ${JSON.stringify(draftMatch?.[2])} but canon says ${JSON.stringify(hit[3])}.`,
    canon_claim_id: Number(hit[1]),
    summary: `Draft contradicts canon on ${draftAttr}.`,
    same_entity_confidence: 1,
  });
}
