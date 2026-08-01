import { loadConfig, type ConfigOverrides } from '../config.js';
import { openDb } from '../db/index.js';
import {
  findLatestRun,
  getEntity,
  getRun,
  insertClaim,
  insertEntity,
  insertRun,
  insertSource,
  listConflicts,
  updateConflictVerdict,
  updateRunStats,
  upsertWork,
} from '../db/repo.js';
import type { EntityKind } from '../db/types.js';
import { ENTITY_KINDS } from '../db/types.js';
import type { ExtractedClaim } from '../ingest/extract.js';
import { requireProject } from '../paths.js';
import { CanonlintError } from '../util/errors.js';
import { log, style } from '../util/logger.js';

export interface MergeOptions extends ConfigOverrides {
  draft: string;
  cwd?: string;
  /** Merge new facts from this check run id (default: latest check). */
  runId?: number;
  /** Keep claims as proposed instead of promoting to canon. */
  proposed?: boolean;
}

export interface MergeResult {
  runId: number;
  checkRunId: number;
  promoted: number;
  skipped: number;
  workTitle: string;
}

interface DraftClaimPayload extends ExtractedClaim {
  locator?: string;
  entity_id?: number | null;
}

function isEntityKind(value: unknown): value is EntityKind {
  return (
    typeof value === 'string' && (ENTITY_KINDS as readonly string[]).includes(value)
  );
}

export function runMerge(options: MergeOptions): MergeResult {
  const paths = requireProject(options.cwd);
  loadConfig(paths, options);

  const db = openDb(paths.dbPath, { mustExist: true });
  try {
    let checkRunId: number;
    if (options.runId !== undefined) {
      const run = getRun(db, options.runId);
      if (run.kind !== 'check') {
        throw new CanonlintError(`Run #${options.runId} is not a check run.`);
      }
      checkRunId = run.id;
    } else {
      const latest = findLatestRun(db, 'check');
      if (!latest) {
        throw new CanonlintError(
          'No check run found. Run `canonlint check <draft>` first.',
        );
      }
      checkRunId = latest.id;
    }

    const openNewFacts = listConflicts(db, {
      runId: checkRunId,
      kind: 'new_fact',
      verdict: 'open',
    });

    const workTitle = `Draft: ${options.draft}`;
    const work = upsertWork(db, { title: workTitle });
    const mergeRun = insertRun(db, {
      kind: 'merge',
      target: options.draft,
      model: 'n/a',
      stats: { status: 'running', fromCheckRun: checkRunId },
    });

    let promoted = 0;
    let skipped = 0;
    const status = options.proposed ? 'proposed' : 'canon';

    for (const conflict of openNewFacts) {
      let draft: DraftClaimPayload;
      try {
        draft = JSON.parse(conflict.draft_claim_json) as DraftClaimPayload;
      } catch {
        skipped += 1;
        updateConflictVerdict(db, conflict.id, 'dismissed');
        continue;
      }

      if (!draft.evidence_quote?.trim() || !draft.attribute || !draft.value) {
        skipped += 1;
        updateConflictVerdict(db, conflict.id, 'dismissed');
        continue;
      }

      let entityId = draft.entity_id ?? null;
      if (entityId != null) {
        try {
          getEntity(db, entityId);
        } catch {
          entityId = null;
        }
      }

      if (entityId == null) {
        if (!draft.entity_name || !isEntityKind(draft.entity_kind)) {
          skipped += 1;
          updateConflictVerdict(db, conflict.id, 'dismissed');
          continue;
        }
        const created = insertEntity(db, {
          name: draft.entity_name,
          kind: draft.entity_kind,
          aliases: draft.entity_aliases ?? [],
        });
        entityId = created.id;
      }

      const source = insertSource(db, {
        work_id: work.id,
        locator: draft.locator ?? options.draft,
        text_excerpt: draft.evidence_quote,
      });

      insertClaim(db, {
        entity_id: entityId,
        attribute: draft.attribute,
        value: draft.value,
        modality: draft.modality ?? 'asserted',
        source_id: source.id,
        status,
        confidence: draft.confidence ?? 1,
        valid_from: draft.valid_from ?? null,
        valid_until: draft.valid_until ?? null,
      });

      updateConflictVerdict(db, conflict.id, 'accepted');
      promoted += 1;
    }

    updateRunStats(db, mergeRun.id, {
      status: 'ok',
      fromCheckRun: checkRunId,
      promoted,
      skipped,
    });

    return {
      runId: mergeRun.id,
      checkRunId,
      promoted,
      skipped,
      workTitle,
    };
  } finally {
    db.close();
  }
}

export function printMerge(result: MergeResult): void {
  log.info('');
  log.success(
    `Merged ${style.bold(String(result.promoted))} new fact(s) ` +
      `from check run #${result.checkRunId}`,
  );
  if (result.skipped > 0) {
    log.detail(`skipped ${result.skipped} (incomplete draft claim)`);
  }
  log.detail(`stored under work "${result.workTitle}"`);
}
