/** In-universe validity of a claim. Not all canon is true canon. */
export type Modality =
  | 'asserted' // narration or reliable statement presented as fact
  | 'believed' // a character believes it; may be wrong
  | 'reported' // secondhand, hearsay, newspaper
  | 'vision_or_dream' // dream, hallucination, prophecy
  | 'lie'; // stated by a character known to be lying

export type EntityKind = 'character' | 'place' | 'object' | 'faction' | 'event';

export type ClaimStatus = 'canon' | 'superseded' | 'proposed' | 'rejected';

export type ConflictKind = 'contradiction' | 'timeline' | 'new_fact' | 'uncertain';

export type Severity = 'low' | 'medium' | 'high';

export type Verdict = 'open' | 'accepted' | 'dismissed';

export type RunKind = 'ingest' | 'check' | 'merge';

export const MODALITIES: readonly Modality[] = [
  'asserted',
  'believed',
  'reported',
  'vision_or_dream',
  'lie',
];

export const ENTITY_KINDS: readonly EntityKind[] = [
  'character',
  'place',
  'object',
  'faction',
  'event',
];

export const DEFAULT_BRANCH = 'main';

export interface Work {
  id: number;
  title: string;
  order_index: number | null;
  published_date: string | null;
  notes: string | null;
  created_at: string;
}

export interface Source {
  id: number;
  work_id: number;
  /** Chapter / scene / offset — human-readable pointer into the work. */
  locator: string;
  /** Verbatim excerpt supporting the claim. Never empty. */
  text_excerpt: string;
  created_at: string;
}

export interface Entity {
  id: number;
  name: string;
  kind: EntityKind;
  aliases_json: string;
  created_at: string;
}

export interface Claim {
  id: number;
  entity_id: number;
  attribute: string;
  value: string;
  modality: Modality;
  /** Nullable in-universe anchors: an event reference or free text. */
  valid_from: string | null;
  valid_until: string | null;
  branch: string;
  status: ClaimStatus;
  /** Retcons supersede, never delete. */
  superseded_by: number | null;
  source_id: number;
  confidence: number;
  created_at: string;
}

export interface Run {
  id: number;
  kind: RunKind;
  target: string;
  created_at: string;
  model: string;
  stats_json: string;
}

export interface Conflict {
  id: number;
  run_id: number;
  draft_claim_json: string;
  canon_claim_id: number | null;
  kind: ConflictKind;
  severity: Severity;
  explanation: string;
  verdict: Verdict;
  created_at: string;
}

export interface NewWork {
  title: string;
  order_index?: number | null;
  published_date?: string | null;
  notes?: string | null;
}

export interface NewSource {
  work_id: number;
  locator: string;
  text_excerpt: string;
}

export interface NewEntity {
  name: string;
  kind: EntityKind;
  aliases?: string[];
}

export interface NewClaim {
  entity_id: number;
  attribute: string;
  value: string;
  modality: Modality;
  source_id: number;
  status: ClaimStatus;
  valid_from?: string | null;
  valid_until?: string | null;
  branch?: string;
  confidence?: number;
}

export interface NewRun {
  kind: RunKind;
  target: string;
  model: string;
  stats?: Record<string, unknown>;
}

export interface NewConflict {
  run_id: number;
  draft_claim: unknown;
  canon_claim_id?: number | null;
  kind: ConflictKind;
  severity: Severity;
  explanation: string;
  verdict?: Verdict;
}

export interface DbStats {
  schemaVersion: number;
  works: number;
  sources: number;
  entities: number;
  claims: number;
  claimsByStatus: Record<string, number>;
  claimsByModality: Record<string, number>;
  runs: number;
  conflicts: number;
  topEntities: { name: string; kind: string; claims: number }[];
  lastRunAt: string | null;
}
