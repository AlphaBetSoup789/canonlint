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

/**
 * Famous Doyle continuity landmines.
 * Each pair is (draftValueNeedle, canonValueNeedle) — directed, so life
 * progression (married → widowed) is not treated as a contradiction.
 */
const HARD_INCOMPATIBLE: ReadonlyArray<{
  attribute: string;
  /** Directed: draft contains `draft`, canon contains `canon`. */
  directed: ReadonlyArray<{ draft: string; canon: string }>;
}> = [
  {
    attribute: 'wound_location',
    directed: [
      { draft: 'leg', canon: 'shoulder' },
      { draft: 'shoulder', canon: 'leg' },
      { draft: 'heel', canon: 'shoulder' },
      { draft: 'shoulder', canon: 'heel' },
    ],
  },
  {
    // Widowed → later "married" without acknowledging the death is the slip.
    // Married → widowed is ordinary chronology and must not hard-flag.
    attribute: 'marital_status',
    directed: [
      { draft: 'married', canon: 'widowed' },
      { draft: 'married', canon: 'widow' },
      { draft: 'married', canon: 'widower' },
    ],
  },
];

const STOP = new Set([
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
  'with',
  'his',
  'her',
  'my',
  'is',
  'was',
  'are',
  'be',
  'as',
  'from',
  'by',
]);

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

function valuesCompatible(a: string, b: string): boolean {
  const left = a.toLowerCase().trim();
  const right = b.toLowerCase().trim();
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const ta = tokens(left);
  const tb = tokens(right);
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap += 1;
  // ≥50% of the smaller token set overlapping → treat as restatement / refinement.
  return overlap / Math.min(ta.size, tb.size) >= 0.5;
}

function hasWord(haystack: string, needle: string): boolean {
  // Word-boundary match so "unmarried" does not count as "married".
  const re = new RegExp(
    `(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`,
    'i',
  );
  return re.test(haystack);
}

function hardIncompatible(
  attr: string,
  draftValue: string,
  canonValue: string,
): boolean {
  const entry = HARD_INCOMPATIBLE.find(
    (h) => h.attribute.toLowerCase() === attr.toLowerCase(),
  );
  if (!entry) return false;
  const draft = draftValue.toLowerCase();
  const canon = canonValue.toLowerCase();
  return entry.directed.some(
    (pair) => hasWord(draft, pair.draft) && hasWord(canon, pair.canon),
  );
}

function holmesAdjudicateResponder(user: string): string | null {
  if (!user.includes('Adjudicate the draft claim')) return null;

  const draftMatch = /"attribute": "([^"]+)"[\s\S]*?"value": "([^"]+)"/.exec(user);
  const draftAttr = draftMatch?.[1] ?? '';
  const draftValueRaw = draftMatch?.[2] ?? '';
  const draftValue = draftValueRaw.toLowerCase();

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
      summary: `${draftAttr} = ${draftValueRaw}`,
    });
  }

  // Hard conflicts first — soft restatement must not swallow famous slips
  // (e.g. token overlap between unrelated values).
  for (const m of exact) {
    const id = Number(m[1]);
    const canonValue = m[3] ?? '';
    if (!validIds.has(id)) continue;
    if (hardIncompatible(draftAttr, draftValue, canonValue)) {
      return JSON.stringify({
        verdict: 'contradiction',
        severity: 'high',
        explanation: `Draft says ${JSON.stringify(draftValueRaw)} but canon says ${JSON.stringify(canonValue)}.`,
        canon_claim_id: id,
        summary: `Draft contradicts canon on ${draftAttr}.`,
      });
    }
  }

  // Prefer consistency / soft restatement over contradiction (precision rule).
  for (const m of exact) {
    const id = Number(m[1]);
    const canonValue = m[3] ?? '';
    if (valuesCompatible(draftValue, canonValue)) {
      return JSON.stringify({
        verdict: 'consistent',
        severity: 'low',
        explanation: 'Restates or refines canon.',
        canon_claim_id: id,
      });
    }
  }

  return JSON.stringify({
    verdict: 'needs_human',
    severity: 'medium',
    explanation:
      'Values differ for the same attribute but are not a clear contradiction; needs a human.',
    canon_claim_id: null,
    summary: `Uncertain whether ${draftAttr} contradicts canon.`,
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
