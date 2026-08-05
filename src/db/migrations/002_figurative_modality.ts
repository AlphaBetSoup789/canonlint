import type { Migration } from './types.js';

/**
 * Schema v2 — add `figurative` to the claims.modality CHECK.
 *
 * Figurative language (idiom, metaphor) is stored for provenance but must
 * never ground adjudication (M3.5). SQLite cannot ALTER a CHECK constraint,
 * so the claims table is rebuilt. Indexes are recreated after the rename.
 */
export const migration002: Migration = {
  version: 2,
  name: 'figurative_modality',
  up: `
CREATE TABLE claims_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  attribute     TEXT    NOT NULL,
  value         TEXT    NOT NULL,
  modality      TEXT    NOT NULL
                  CHECK (modality IN
                    ('asserted','believed','reported','vision_or_dream','lie','figurative')),
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

INSERT INTO claims_new
  (id, entity_id, attribute, value, modality, valid_from, valid_until,
   branch, status, superseded_by, source_id, confidence, created_at)
SELECT
  id, entity_id, attribute, value, modality, valid_from, valid_until,
  branch, status, superseded_by, source_id, confidence, created_at
FROM claims;

DROP TABLE claims;
ALTER TABLE claims_new RENAME TO claims;

CREATE INDEX idx_claims_entity_attr ON claims(entity_id, attribute);
CREATE INDEX idx_claims_lookup      ON claims(branch, status, entity_id);
CREATE INDEX idx_claims_source      ON claims(source_id);
CREATE INDEX idx_claims_superseded  ON claims(superseded_by);
`,
};
