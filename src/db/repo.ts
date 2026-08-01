import type { Db } from './index.js';
import { getSchemaVersion } from './index.js';
import { CanonlintError } from '../util/errors.js';
import {
  DEFAULT_BRANCH,
  type Claim,
  type Conflict,
  type DbStats,
  type Entity,
  type NewClaim,
  type NewConflict,
  type NewEntity,
  type NewRun,
  type NewSource,
  type NewWork,
  type Run,
  type Source,
  type Work,
} from './types.js';

// --- works -----------------------------------------------------------------

export function insertWork(db: Db, work: NewWork): Work {
  const info = db
    .prepare(
      `INSERT INTO works (title, order_index, published_date, notes)
       VALUES (@title, @order_index, @published_date, @notes)`,
    )
    .run({
      title: work.title,
      order_index: work.order_index ?? null,
      published_date: work.published_date ?? null,
      notes: work.notes ?? null,
    });
  return getWork(db, Number(info.lastInsertRowid));
}

export function getWork(db: Db, id: number): Work {
  const row = db.prepare('SELECT * FROM works WHERE id = ?').get(id) as
    Work | undefined;
  if (!row) throw new CanonlintError(`No work with id ${id}.`);
  return row;
}

export function findWorkByTitle(db: Db, title: string): Work | undefined {
  return db.prepare('SELECT * FROM works WHERE title = ?').get(title) as
    Work | undefined;
}

/** Idempotent: reuses an existing work with the same title. */
export function upsertWork(db: Db, work: NewWork): Work {
  return findWorkByTitle(db, work.title) ?? insertWork(db, work);
}

export function listWorks(db: Db): Work[] {
  return db
    .prepare('SELECT * FROM works ORDER BY order_index IS NULL, order_index, id')
    .all() as Work[];
}

// --- sources ---------------------------------------------------------------

export function insertSource(db: Db, source: NewSource): Source {
  if (source.text_excerpt.trim() === '') {
    throw new CanonlintError(
      'Refusing to store a source with an empty excerpt. Every claim must be ' +
        'traceable to real text in the work.',
    );
  }
  const info = db
    .prepare(
      `INSERT INTO sources (work_id, locator, text_excerpt)
       VALUES (@work_id, @locator, @text_excerpt)`,
    )
    .run(source);
  return db
    .prepare('SELECT * FROM sources WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Source;
}

export function getSource(db: Db, id: number): Source | undefined {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Source | undefined;
}

// --- entities --------------------------------------------------------------

export function insertEntity(db: Db, entity: NewEntity): Entity {
  const info = db
    .prepare(
      `INSERT INTO entities (name, kind, aliases_json)
       VALUES (@name, @kind, @aliases_json)`,
    )
    .run({
      name: entity.name,
      kind: entity.kind,
      aliases_json: JSON.stringify(entity.aliases ?? []),
    });
  return db
    .prepare('SELECT * FROM entities WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Entity;
}

export function findEntity(
  db: Db,
  name: string,
  kind?: NewEntity['kind'],
): Entity | undefined {
  if (kind) {
    return db
      .prepare('SELECT * FROM entities WHERE name = ? COLLATE NOCASE AND kind = ?')
      .get(name, kind) as Entity | undefined;
  }
  return db
    .prepare('SELECT * FROM entities WHERE name = ? COLLATE NOCASE')
    .get(name) as Entity | undefined;
}

export function upsertEntity(db: Db, entity: NewEntity): Entity {
  return findEntity(db, entity.name, entity.kind) ?? insertEntity(db, entity);
}

export function getEntityAliases(entity: Entity): string[] {
  try {
    const parsed: unknown = JSON.parse(entity.aliases_json);
    return Array.isArray(parsed) ? parsed.filter((a) => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function addEntityAliases(db: Db, entityId: number, aliases: string[]): void {
  const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId) as
    Entity | undefined;
  if (!entity) throw new CanonlintError(`No entity with id ${entityId}.`);
  const merged = [...new Set([...getEntityAliases(entity), ...aliases])];
  db.prepare('UPDATE entities SET aliases_json = ? WHERE id = ?').run(
    JSON.stringify(merged),
    entityId,
  );
}

export function getEntity(db: Db, id: number): Entity {
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as
    Entity | undefined;
  if (!row) throw new CanonlintError(`No entity with id ${id}.`);
  return row;
}

export function listEntities(db: Db, kind?: NewEntity['kind']): Entity[] {
  if (kind) {
    return db
      .prepare('SELECT * FROM entities WHERE kind = ? ORDER BY name COLLATE NOCASE')
      .all(kind) as Entity[];
  }
  return db
    .prepare('SELECT * FROM entities ORDER BY name COLLATE NOCASE')
    .all() as Entity[];
}

/**
 * Resolve an entity by canonical name or any recorded alias (case-insensitive).
 * App-side alias scan keeps the lookup portable and avoids JSON1 edge cases.
 */
export function findEntityByNameOrAlias(
  db: Db,
  name: string,
  kind?: NewEntity['kind'],
): Entity | undefined {
  const byName = findEntity(db, name, kind);
  if (byName) return byName;

  const needle = name.trim().toLowerCase();
  if (needle === '') return undefined;

  for (const entity of listEntities(db, kind)) {
    if (entity.name.toLowerCase() === needle) return entity;
    for (const alias of getEntityAliases(entity)) {
      if (alias.toLowerCase() === needle) return entity;
    }
  }
  return undefined;
}

// --- claims ----------------------------------------------------------------

/**
 * Insert a claim. `source_id` is required by the schema, so there is no code
 * path that produces an unprovenanced claim.
 */
export function insertClaim(db: Db, claim: NewClaim): Claim {
  const info = db
    .prepare(
      `INSERT INTO claims
         (entity_id, attribute, value, modality, valid_from, valid_until,
          branch, status, source_id, confidence)
       VALUES
         (@entity_id, @attribute, @value, @modality, @valid_from, @valid_until,
          @branch, @status, @source_id, @confidence)`,
    )
    .run({
      entity_id: claim.entity_id,
      attribute: claim.attribute,
      value: claim.value,
      modality: claim.modality,
      valid_from: claim.valid_from ?? null,
      valid_until: claim.valid_until ?? null,
      branch: claim.branch ?? DEFAULT_BRANCH,
      status: claim.status,
      source_id: claim.source_id,
      confidence: claim.confidence ?? 1.0,
    });
  return db
    .prepare('SELECT * FROM claims WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Claim;
}

/**
 * Record a retcon. The old claim is never deleted — it is marked superseded and
 * points at its replacement, so the history of the canon stays readable.
 */
export function supersedeClaim(db: Db, oldId: number, newId: number): void {
  if (oldId === newId) {
    throw new CanonlintError('A claim cannot supersede itself.');
  }
  const result = db
    .prepare(`UPDATE claims SET status = 'superseded', superseded_by = ? WHERE id = ?`)
    .run(newId, oldId);
  if (result.changes === 0) {
    throw new CanonlintError(`No claim with id ${oldId}.`);
  }
}

export function setClaimStatus(db: Db, id: number, status: Claim['status']): void {
  const result = db
    .prepare('UPDATE claims SET status = ? WHERE id = ?')
    .run(status, id);
  if (result.changes === 0) {
    throw new CanonlintError(`No claim with id ${id}.`);
  }
}

export interface ClaimQuery {
  entityId?: number;
  attribute?: string;
  branch?: string;
  status?: Claim['status'];
}

export function findClaims(db: Db, query: ClaimQuery = {}): Claim[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.entityId !== undefined) {
    where.push('entity_id = @entityId');
    params.entityId = query.entityId;
  }
  if (query.attribute !== undefined) {
    where.push('attribute = @attribute COLLATE NOCASE');
    params.attribute = query.attribute;
  }
  if (query.branch !== undefined) {
    where.push('branch = @branch');
    params.branch = query.branch;
  }
  if (query.status !== undefined) {
    where.push('status = @status');
    params.status = query.status;
  }
  const sql =
    'SELECT * FROM claims' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY id';
  return db.prepare(sql).all(params) as Claim[];
}

/** A claim joined to the excerpt that proves it — the citation unit. */
export interface CitedClaim extends Claim {
  entity_name: string;
  entity_kind: string;
  work_title: string;
  locator: string;
  text_excerpt: string;
}

export function findCitedClaims(db: Db, query: ClaimQuery = {}): CitedClaim[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.entityId !== undefined) {
    where.push('c.entity_id = @entityId');
    params.entityId = query.entityId;
  }
  if (query.attribute !== undefined) {
    where.push('c.attribute = @attribute COLLATE NOCASE');
    params.attribute = query.attribute;
  }
  if (query.branch !== undefined) {
    where.push('c.branch = @branch');
    params.branch = query.branch;
  }
  if (query.status !== undefined) {
    where.push('c.status = @status');
    params.status = query.status;
  }
  const sql = `
    SELECT c.*, e.name AS entity_name, e.kind AS entity_kind,
           w.title AS work_title, s.locator, s.text_excerpt
    FROM claims c
    JOIN entities e ON e.id = c.entity_id
    JOIN sources  s ON s.id = c.source_id
    JOIN works    w ON w.id = s.work_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY w.order_index IS NULL, w.order_index, c.id
  `;
  return db.prepare(sql).all(params) as CitedClaim[];
}

export function getCitedClaimById(db: Db, id: number): CitedClaim | undefined {
  return db
    .prepare(
      `SELECT c.*, e.name AS entity_name, e.kind AS entity_kind,
              w.title AS work_title, s.locator, s.text_excerpt
       FROM claims c
       JOIN entities e ON e.id = c.entity_id
       JOIN sources  s ON s.id = c.source_id
       JOIN works    w ON w.id = s.work_id
       WHERE c.id = ?`,
    )
    .get(id) as CitedClaim | undefined;
}

/**
 * Candidate canon claims for adjudication. Prefers exact attribute matches,
 * then other canon claims on the same entity (related-attribute fallback
 * without vector retrieval).
 */
export function findCandidateClaims(
  db: Db,
  options: {
    entityId: number;
    attribute?: string;
    branch?: string;
    status?: Claim['status'];
    /** Cap on non-exact related claims appended after exact matches. */
    relatedLimit?: number;
  },
): CitedClaim[] {
  const branch = options.branch ?? DEFAULT_BRANCH;
  const status = options.status ?? 'canon';
  const exact = options.attribute
    ? findCitedClaims(db, {
        entityId: options.entityId,
        attribute: options.attribute,
        branch,
        status,
      })
    : [];

  const allForEntity = findCitedClaims(db, {
    entityId: options.entityId,
    branch,
    status,
  });

  if (!options.attribute) {
    return allForEntity;
  }

  const exactIds = new Set(exact.map((c) => c.id));
  const relatedLimit = options.relatedLimit ?? 12;
  const related = allForEntity
    .filter((c) => !exactIds.has(c.id))
    .slice(0, relatedLimit);
  return [...exact, ...related];
}

// --- runs & conflicts ------------------------------------------------------

export function insertRun(db: Db, run: NewRun): Run {
  const info = db
    .prepare(
      `INSERT INTO runs (kind, target, model, stats_json)
       VALUES (@kind, @target, @model, @stats_json)`,
    )
    .run({
      kind: run.kind,
      target: run.target,
      model: run.model,
      stats_json: JSON.stringify(run.stats ?? {}),
    });
  return db
    .prepare('SELECT * FROM runs WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Run;
}

export function updateRunStats(
  db: Db,
  runId: number,
  stats: Record<string, unknown>,
): void {
  db.prepare('UPDATE runs SET stats_json = ? WHERE id = ?').run(
    JSON.stringify(stats),
    runId,
  );
}

export function insertConflict(db: Db, conflict: NewConflict): number {
  const info = db
    .prepare(
      `INSERT INTO conflicts
         (run_id, draft_claim_json, canon_claim_id, kind, severity, explanation, verdict)
       VALUES
         (@run_id, @draft_claim_json, @canon_claim_id, @kind, @severity, @explanation, @verdict)`,
    )
    .run({
      run_id: conflict.run_id,
      draft_claim_json: JSON.stringify(conflict.draft_claim),
      canon_claim_id: conflict.canon_claim_id ?? null,
      kind: conflict.kind,
      severity: conflict.severity,
      explanation: conflict.explanation,
      verdict: conflict.verdict ?? 'open',
    });
  return Number(info.lastInsertRowid);
}

export function getRun(db: Db, id: number): Run {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined;
  if (!row) throw new CanonlintError(`No run with id ${id}.`);
  return row;
}

export function findLatestRun(db: Db, kind?: Run['kind']): Run | undefined {
  if (kind) {
    return db
      .prepare('SELECT * FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .get(kind) as Run | undefined;
  }
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as
    Run | undefined;
}

export interface ConflictQuery {
  runId?: number;
  kind?: Conflict['kind'];
  verdict?: Conflict['verdict'];
}

export function listConflicts(db: Db, query: ConflictQuery = {}): Conflict[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.runId !== undefined) {
    where.push('run_id = @runId');
    params.runId = query.runId;
  }
  if (query.kind !== undefined) {
    where.push('kind = @kind');
    params.kind = query.kind;
  }
  if (query.verdict !== undefined) {
    where.push('verdict = @verdict');
    params.verdict = query.verdict;
  }
  const sql =
    'SELECT * FROM conflicts' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY id';
  return db.prepare(sql).all(params) as Conflict[];
}

export function updateConflictVerdict(
  db: Db,
  id: number,
  verdict: Conflict['verdict'],
): void {
  const result = db
    .prepare('UPDATE conflicts SET verdict = ? WHERE id = ?')
    .run(verdict, id);
  if (result.changes === 0) {
    throw new CanonlintError(`No conflict with id ${id}.`);
  }
}

// --- stats -----------------------------------------------------------------

function countRows(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function groupCount(db: Db, table: string, column: string): Record<string, number> {
  const rows = db
    .prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`)
    .all() as { k: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.k, r.n]));
}

export function getStats(db: Db): DbStats {
  const lastRun = db
    .prepare('SELECT created_at FROM runs ORDER BY id DESC LIMIT 1')
    .get() as { created_at: string } | undefined;

  const topEntities = db
    .prepare(
      `SELECT e.name, e.kind, COUNT(c.id) AS claims
       FROM entities e
       LEFT JOIN claims c ON c.entity_id = e.id AND c.status = 'canon'
       GROUP BY e.id
       HAVING claims > 0
       ORDER BY claims DESC, e.name
       LIMIT 10`,
    )
    .all() as { name: string; kind: string; claims: number }[];

  return {
    schemaVersion: getSchemaVersion(db),
    works: countRows(db, 'works'),
    sources: countRows(db, 'sources'),
    entities: countRows(db, 'entities'),
    claims: countRows(db, 'claims'),
    claimsByStatus: groupCount(db, 'claims', 'status'),
    claimsByModality: groupCount(db, 'claims', 'modality'),
    runs: countRows(db, 'runs'),
    conflicts: countRows(db, 'conflicts'),
    topEntities,
    lastRunAt: lastRun?.created_at ?? null,
  };
}
