import { evidenceInChunk } from '../../src/ingest/extract.js';
import type { ExtractedClaim } from '../../src/ingest/extract.js';
import { MockProvider } from '../../src/llm/mock.js';
import type { CompletionRequest } from '../../src/llm/types.js';

/**
 * Surface forms that should resolve to the same Holmes-canon entity.
 * Matching is case-insensitive; order within a group does not matter.
 */
const HOLMES_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['sherlock holmes', 'holmes', 'mr. holmes', 'mr holmes', 'my friend holmes'],
  [
    'dr. watson',
    'dr watson',
    'doctor watson',
    'john h. watson',
    'john watson',
    'watson',
    'james watson',
  ],
  ['mary morstan', 'mary watson', 'mrs. watson', 'mrs watson'],
  ['professor moriarty', 'moriarty', 'professor james moriarty', 'james moriarty'],
  ['mycroft holmes', 'mycroft'],
  ['mrs. hudson', 'mrs hudson', 'the landlady'],
  ['inspector lestrade', 'lestrade'],
  ['colonel sebastian moran', 'sebastian moran', 'colonel moran', 'moran'],
];

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function namesInSameGroup(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left === right) return true;
  for (const group of HOLMES_ALIAS_GROUPS) {
    const members = group.map(normalizeName);
    if (members.includes(left) && members.includes(right)) return true;
  }
  return (
    left.includes(right) ||
    right.includes(left) ||
    left.replace(/\./g, '') === right.replace(/\./g, '')
  );
}

function holmesResolveResponder(user: string): string | null {
  if (!user.includes('entity resolution')) return null;

  const surface = /Surface name: (.+)/.exec(user)?.[1]?.trim() ?? '';
  const idLines = [...user.matchAll(/- id=(\d+) name="([^"]+)"/g)];

  for (const m of idLines) {
    const id = Number(m[1]);
    const candidateName = m[2] ?? '';
    const rest = user.slice(user.indexOf(m[0]));
    const aliasLine = /aliases: ([^\n]*)/.exec(rest)?.[1] ?? '';
    const aliasParts = aliasLine
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (
      namesInSameGroup(surface, candidateName) ||
      aliasParts.some((alias) => namesInSameGroup(surface, alias))
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

function holmesAdjudicateResponder(user: string): string | null {
  if (!user.includes('Adjudicate the draft claim')) return null;

  const draftMatch = /"attribute": "([^"]+)"[\s\S]*?"value": "([^"]+)"/.exec(user);
  const draftAttr = draftMatch?.[1] ?? '';
  const draftValue = (draftMatch?.[2] ?? '').toLowerCase();

  const candidateLines = [
    ...user.matchAll(/- id=(\d+) attr="([^"]+)" value="([^"]+)"/g),
  ];
  const validIds = new Set(candidateLines.map((m) => Number(m[1])));

  const exact = candidateLines.filter(
    (m) => (m[2] ?? '').toLowerCase() === draftAttr.toLowerCase(),
  );

  if (exact.length === 0) {
    return JSON.stringify({
      verdict: 'new_fact',
      severity: 'low',
      explanation: 'No canon claim for this attribute; new fact.',
      summary: `${draftAttr} = ${draftMatch?.[2] ?? ''}`,
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
      });
    }
  }

  const hit = exact[0]!;
  const canonClaimId = Number(hit[1]);
  if (!validIds.has(canonClaimId)) {
    return JSON.stringify({
      verdict: 'needs_human',
      severity: 'medium',
      explanation: 'Cannot cite a canon claim id not present in candidates.',
      canon_claim_id: null,
    });
  }

  return JSON.stringify({
    verdict: 'contradiction',
    severity: 'high',
    explanation: `Draft says ${JSON.stringify(draftMatch?.[2])} but canon says ${JSON.stringify(hit[3])}.`,
    canon_claim_id: canonClaimId,
    summary: `Draft contradicts canon on ${draftAttr}.`,
  });
}

function holmesExtractResponder(
  user: string,
  storyClaims: readonly ExtractedClaim[],
): string {
  const kept = storyClaims.filter((claim) =>
    evidenceInChunk(claim.evidence_quote, user),
  );
  return JSON.stringify({ claims: kept });
}

/**
 * Deterministic mock LLM for the Holmes demo: replays pre-extracted claims for
 * the active story and applies Holmes-aware entity resolution + adjudication.
 */
export function mockHolmesProvider(storyClaims: ExtractedClaim[]): MockProvider {
  return new MockProvider({
    model: 'holmes-mock',
    responder: (request: CompletionRequest) => {
      const resolved = holmesResolveResponder(request.user);
      if (resolved) return resolved;

      const adjudicated = holmesAdjudicateResponder(request.user);
      if (adjudicated) return adjudicated;

      return holmesExtractResponder(request.user, storyClaims);
    },
  });
}
