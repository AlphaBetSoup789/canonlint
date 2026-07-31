import type { Migration } from './types.js';

/**
 * Schema v1.
 *
 * Invariants encoded here rather than in application code, so they hold no
 * matter which code path writes:
 *   - Every claim MUST reference a source (`source_id NOT NULL`). A claim
 *     without provenance is a bug, and the database refuses to store one.
 *   - Every source MUST carry a non-empty excerpt.
 *   - Retcons are supersedence, never deletion: a superseded claim keeps its
 *     row and points at the claim that replaced it.
 *   - `branch` exists from v1 so later branch support needs no migration.
 *     v1 only ever writes 'main'.
 */
export const migration001: Migration = {
  version: 1,
  name: 'init',
  up: `
CREATE TABLE works (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL UNIQUE,
  order_index    INTEGER,
  published_date TEXT,
  notes          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_works_order ON works(order_index);

CREATE TABLE sources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id      INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  locator      TEXT    NOT NULL,
  text_excerpt TEXT    NOT NULL CHECK (length(trim(text_excerpt)) > 0),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sources_work ON sources(work_id);

CREATE TABLE entities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  kind         TEXT    NOT NULL
                 CHECK (kind IN ('character','place','object','faction','event')),
  aliases_json TEXT    NOT NULL DEFAULT '[]',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, kind)
);

CREATE INDEX idx_entities_name ON entities(name COLLATE NOCASE);
CREATE INDEX idx_entities_kind ON entities(kind);

CREATE TABLE claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  attribute     TEXT    NOT NULL,
  value         TEXT    NOT NULL,
  modality      TEXT    NOT NULL
                  CHECK (modality IN
                    ('asserted','believed','reported','vision_or_dream','lie')),
  valid_from    TEXT,
  valid_until   TEXT,
  branch        TEXT    NOT NULL DEFAULT 'main',
  status        TEXT    NOT NULL
                  CHECK (status IN ('canon','superseded','proposed','rejected')),
  superseded_by INTEGER REFERENCES claims(id) ON DELETE SET NULL,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  confidence    REAL    NOT NULL DEFAULT 1.0
                  CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (superseded_by IS NULL OR superseded_by != id)
);

CREATE INDEX idx_claims_entity_attr ON claims(entity_id, attribute);
CREATE INDEX idx_claims_lookup      ON claims(branch, status, entity_id);
CREATE INDEX idx_claims_source      ON claims(source_id);
CREATE INDEX idx_claims_superseded  ON claims(superseded_by);

CREATE TABLE runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL CHECK (kind IN ('ingest','check','merge')),
  target     TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  model      TEXT    NOT NULL,
  stats_json TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_runs_kind ON runs(kind, created_at);

CREATE TABLE conflicts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  draft_claim_json TEXT    NOT NULL,
  canon_claim_id   INTEGER REFERENCES claims(id) ON DELETE SET NULL,
  kind             TEXT    NOT NULL
                     CHECK (kind IN
                       ('contradiction','timeline','new_fact','uncertain')),
  severity         TEXT    NOT NULL CHECK (severity IN ('low','medium','high')),
  explanation      TEXT    NOT NULL,
  verdict          TEXT    NOT NULL DEFAULT 'open'
                     CHECK (verdict IN ('open','accepted','dismissed')),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_conflicts_run  ON conflicts(run_id, kind);
CREATE INDEX idx_conflicts_kind ON conflicts(kind);
`,
};
