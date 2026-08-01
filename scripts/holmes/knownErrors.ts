import type { CheckFinding } from '../../src/check/report.js';

export interface KnownErrorPattern {
  id: string;
  title: string;
  /** Narrative blurb shown when matching findings appear in the report. */
  blurb: string;
  match: (finding: CheckFinding) => boolean;
}

function entityMatches(finding: CheckFinding, ...needles: string[]): boolean {
  const claim = finding.draft.claim;
  const haystack = [
    claim.entity_name,
    ...claim.entity_aliases,
    finding.summary,
    finding.explanation,
    claim.attribute,
    claim.value,
  ]
    .join(' ')
    .toLowerCase();
  return needles.some((n) => haystack.includes(n.toLowerCase()));
}

function attributeMatches(finding: CheckFinding, ...attrs: string[]): boolean {
  const attr = finding.draft.claim.attribute.toLowerCase();
  return attrs.some((a) => attr.includes(a.toLowerCase()));
}

/** Optional prose enrichments for well-known Doyle continuity debates. */
export const KNOWN_ERROR_PATTERNS: readonly KnownErrorPattern[] = [
  {
    id: 'watson-wound',
    title: "Watson's wandering war wound",
    blurb:
      'Dr. Watson cannot seem to agree whether his Afghan bullet struck his leg or his shoulder. ' +
      "Doyle was famously casual about Watson's biography — canonlint catches each fresh placement.",
    match: (f) =>
      entityMatches(f, 'watson') &&
      attributeMatches(f, 'wound', 'injury', 'shoulder', 'leg', 'arm') &&
      (f.kind === 'contradiction' || f.kind === 'timeline'),
  },
  {
    id: 'mary-timeline',
    title: 'Mary Morstan / Mary Watson',
    blurb:
      'Mary appears in *The Sign of the Four*, marries Watson, then quietly vanishes from the record ' +
      "while Watson's domestic situation keeps shifting. Timeline and marital-status claims are a " +
      'fertile hunting ground.',
    match: (f) =>
      (entityMatches(f, 'mary morstan', 'mary watson', 'mrs. watson', 'mrs watson') ||
        (entityMatches(f, 'watson') &&
          attributeMatches(f, 'marital', 'wife', 'widow'))) &&
      (f.kind === 'contradiction' || f.kind === 'timeline'),
  },
  {
    id: 'watson-name',
    title: "Watson's Christian name",
    blurb:
      'The good doctor is John H. Watson in most accounts, but "James" slips through in places. ' +
      'Alias resolution helps; attribute clashes still flag the inconsistency.',
    match: (f) =>
      entityMatches(f, 'watson') &&
      attributeMatches(f, 'name', 'first name', 'christian name', 'given name') &&
      f.kind === 'contradiction',
  },
  {
    id: 'holmes-residence',
    title: '221B and Baker Street',
    blurb:
      "Holmes and Watson's shared rooms at 221B Baker Street are canonical — until a later story " +
      'rearranges the furniture, the address, or who lives there. Soft restatements of the same ' +
      'address ("Baker Street" vs "221B Baker Street") stay out of Contradictions.',
    match: (f) =>
      entityMatches(f, 'holmes', 'watson', 'baker street', '221b') &&
      attributeMatches(f, 'residence', 'address', 'home', 'rooms', 'lodging') &&
      f.kind === 'contradiction',
  },
  {
    id: 'moriarty-survival',
    title: 'Moriarty at the Reichenbach Fall',
    blurb:
      'The Napoleon of crime plunges at Reichenbach; Holmes returns in *The Empty House*. ' +
      "Claims about Moriarty's fate and Holmes's absence should not casually coexist.",
    match: (f) =>
      entityMatches(f, 'moriarty', 'reichenbach', 'holmes') &&
      attributeMatches(f, 'death', 'alive', 'survival', 'fate', 'disappearance') &&
      (f.kind === 'contradiction' || f.kind === 'timeline'),
  },
];

export function knownPatternsForFinding(finding: CheckFinding): KnownErrorPattern[] {
  return KNOWN_ERROR_PATTERNS.filter((p) => p.match(finding));
}
