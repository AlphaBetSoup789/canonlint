import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { openDb } from '../db/index.js';
import {
  findCandidateClaims,
  getCitedClaimById,
  insertConflict,
  insertRun,
  updateRunStats,
} from '../db/repo.js';
import { DEFAULT_BRANCH } from '../db/types.js';
import {
  adjudicateClaim,
  defaultSummary,
  toConflictKind,
} from '../check/adjudicate.js';
import {
  printCheckReport,
  reportToJson,
  type CheckFinding,
  type CheckReport,
} from '../check/report.js';
import { chunkCorpus } from '../ingest/chunk.js';
import { extractClaimsFromChunks } from '../ingest/extract.js';
import { loadCorpus } from '../ingest/load.js';
import { resolveEntity } from '../ingest/resolve.js';
import { createProvider, estimateRunCost, formatUsd } from '../llm/index.js';
import type { LlmProvider, TokenUsage } from '../llm/types.js';
import { ZERO_USAGE, addUsage } from '../llm/types.js';
import { requireProject } from '../paths.js';
import { SpendCapError } from '../util/errors.js';
import { log } from '../util/logger.js';

export interface CheckOptions extends ConfigOverrides {
  draft: string;
  cwd?: string;
  json?: boolean;
  /** Write report markdown to this path (in addition to stdout). */
  out?: string;
  llm?: LlmProvider;
}

export type CheckResult = CheckReport;

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const paths = requireProject(options.cwd);
  const stringOverrides: ConfigOverrides = {};
  if (options.provider) stringOverrides.provider = options.provider;
  if (options.model) stringOverrides.model = options.model;
  if (options.maxSpendUsd !== undefined) {
    stringOverrides.maxSpendUsd = options.maxSpendUsd;
  }
  const cfg = loadConfig(paths, stringOverrides);
  const llm = options.llm ?? createProvider(cfg);

  const corpus = loadCorpus(options.draft);
  const draftPath = resolve(options.draft);

  const estimate = estimateRunCost({ text: corpus.text, config: cfg });
  log.info(
    `Estimated cost ${formatUsd(estimate.usd)} ` +
      `(~${estimate.inputTokens.toLocaleString()} in / ` +
      `~${estimate.outputTokens.toLocaleString()} out on ${estimate.model})`,
  );
  if (estimate.usd > cfg.maxSpendUsd) {
    throw new SpendCapError(estimate.usd, cfg.maxSpendUsd);
  }

  const chunks = chunkCorpus(corpus.files, cfg.chunkWords);
  log.info(`Extracting ${chunks.length} draft chunk(s)…`);

  const db = openDb(paths.dbPath, { mustExist: true });
  try {
    const run = insertRun(db, {
      kind: 'check',
      target: draftPath,
      model: llm.model,
      stats: { status: 'running', estimatedUsd: estimate.usd },
    });

    const {
      claims: extracted,
      usage: extractUsage,
      warnings,
    } = await extractClaimsFromChunks(llm, chunks);

    let usage: TokenUsage = extractUsage;
    const contradictions: CheckFinding[] = [];
    const timeline: CheckFinding[] = [];
    const newFacts: CheckFinding[] = [];
    const uncertain: CheckFinding[] = [];
    let entitiesUnresolved = 0;
    let claimsChecked = 0;

    /**
     * Resolution + adjudication call the model per draft claim, so the
     * preflight extraction-only estimate can be exceeded mid-run. Re-check
     * actual spend as we go and abort rather than silently blow the cap.
     */
    const assertWithinSpendCap = (): void => {
      const spentSoFar = llm.costOf(usage);
      if (spentSoFar > cfg.maxSpendUsd) {
        updateRunStats(db, run.id, {
          status: 'aborted_spend_cap',
          claimsChecked,
          estimatedUsd: estimate.usd,
          actualUsd: spentSoFar,
          usage,
          warnings,
        });
        throw new SpendCapError(spentSoFar, cfg.maxSpendUsd);
      }
    };

    for (const draftClaim of extracted) {
      const resolved = await resolveEntity(db, llm, {
        name: draftClaim.entity_name,
        kind: draftClaim.entity_kind,
        aliases: draftClaim.entity_aliases,
        createIfMissing: false,
        // Linting a draft must not have side effects on canon — no alias writes.
        mutate: false,
      });
      usage = addUsage(usage, resolved.usage);
      assertWithinSpendCap();

      if (!resolved.entity) {
        entitiesUnresolved += 1;
        // Unknown entity → treat as new fact (nothing in canon to contradict).
        const finding: CheckFinding = {
          kind: 'new_fact',
          severity: 'low',
          summary: defaultSummary(draftClaim, draftClaim.entity_name),
          explanation: 'No matching entity in canon; treating as a potential new fact.',
          draft: {
            path: draftPath,
            locator: draftClaim.locator,
            quote: draftClaim.evidence_quote,
            claim: draftClaim,
          },
        };
        newFacts.push(finding);
        insertConflict(db, {
          run_id: run.id,
          draft_claim: { ...draftClaim, entity_id: null },
          canon_claim_id: null,
          kind: 'new_fact',
          severity: 'low',
          explanation: finding.explanation,
        });
        claimsChecked += 1;
        continue;
      }

      const entity = resolved.entity;
      const candidates = findCandidateClaims(db, {
        entityId: entity.id,
        attribute: draftClaim.attribute,
        branch: DEFAULT_BRANCH,
        status: 'canon',
      });

      const {
        adjudication,
        usage: adjUsage,
        parseError,
      } = await adjudicateClaim(llm, {
        draftClaim,
        entityName: entity.name,
        candidates,
      });
      usage = addUsage(usage, adjUsage);
      assertWithinSpendCap();
      if (parseError) {
        warnings.push(
          `Adjudication parse error for ${entity.name}.${draftClaim.attribute}: ${parseError}`,
        );
      }

      const kind = toConflictKind(adjudication.verdict);
      claimsChecked += 1;
      if (kind === null) continue;

      let canon: CheckFinding['canon'] | undefined;
      if (
        (kind === 'contradiction' || kind === 'timeline') &&
        adjudication.canon_claim_id
      ) {
        const cited =
          getCitedClaimById(db, adjudication.canon_claim_id) ??
          candidates.find((c) => c.id === adjudication.canon_claim_id);
        if (!cited || !cited.text_excerpt.trim()) {
          // Precision gate — should already be enforced in adjudicate, but belt+braces.
          uncertain.push({
            kind: 'uncertain',
            severity: adjudication.severity,
            summary: adjudication.summary ?? defaultSummary(draftClaim, entity.name),
            explanation:
              adjudication.explanation +
              ' [missing canon citation; routed to Uncertain]',
            draft: {
              path: draftPath,
              locator: draftClaim.locator,
              quote: draftClaim.evidence_quote,
              claim: draftClaim,
            },
          });
          insertConflict(db, {
            run_id: run.id,
            draft_claim: { ...draftClaim, entity_id: entity.id },
            canon_claim_id: null,
            kind: 'uncertain',
            severity: adjudication.severity,
            explanation: adjudication.explanation,
          });
          continue;
        }
        canon = {
          claimId: cited.id,
          workTitle: cited.work_title,
          locator: cited.locator,
          excerpt: cited.text_excerpt,
        };
      }

      const finding: CheckFinding = {
        kind,
        severity: adjudication.severity,
        summary: adjudication.summary ?? defaultSummary(draftClaim, entity.name),
        explanation: adjudication.explanation,
        draft: {
          path: draftPath,
          locator: draftClaim.locator,
          quote: draftClaim.evidence_quote,
          claim: draftClaim,
        },
        ...(canon ? { canon } : {}),
      };

      if (kind === 'contradiction') contradictions.push(finding);
      else if (kind === 'timeline') timeline.push(finding);
      else if (kind === 'new_fact') newFacts.push(finding);
      else uncertain.push(finding);

      insertConflict(db, {
        run_id: run.id,
        draft_claim: { ...draftClaim, entity_id: entity.id },
        canon_claim_id: canon?.claimId ?? null,
        kind,
        severity: adjudication.severity,
        explanation: adjudication.explanation,
      });
    }

    const actualUsd = llm.costOf(usage);
    const report: CheckReport = {
      runId: run.id,
      draftPath,
      contradictions,
      timeline,
      newFacts,
      uncertain,
      claimsChecked,
      entitiesUnresolved,
      usage: usage ?? ZERO_USAGE,
      estimatedUsd: estimate.usd,
      actualUsd,
      model: llm.model,
      provider: llm.name,
      warnings,
    };

    updateRunStats(db, run.id, {
      status: 'ok',
      claimsChecked,
      contradictions: contradictions.length,
      timeline: timeline.length,
      newFacts: newFacts.length,
      uncertain: uncertain.length,
      entitiesUnresolved,
      estimatedUsd: estimate.usd,
      actualUsd,
      usage,
      warnings,
    });

    if (options.out) {
      writeFileSync(options.out, renderMarkdown(report), 'utf8');
      log.detail(`Wrote ${options.out}`);
    }

    return report;
  } finally {
    db.close();
  }
}

function renderMarkdown(report: CheckReport): string {
  const lines: string[] = [
    `# Continuity report`,
    '',
    `Draft: \`${report.draftPath}\``,
    '',
  ];
  const sections: [string, CheckFinding[]][] = [
    ['Contradictions', report.contradictions],
    ['Timeline issues', report.timeline],
    ['New facts', report.newFacts],
    ['Uncertain', report.uncertain],
  ];
  for (const [title, findings] of sections) {
    lines.push(`## ${title} (${findings.length})`, '');
    if (findings.length === 0) {
      lines.push('_none_', '');
      continue;
    }
    for (const f of findings) {
      lines.push(`### ${f.summary}`, '');
      if (f.canon) {
        lines.push(
          `- **canon** ${f.canon.workTitle}, ${f.canon.locator} — "${f.canon.excerpt}"`,
        );
      }
      lines.push(
        `- **draft** ${report.draftPath}:${f.draft.locator} — "${f.draft.quote}"`,
      );
      lines.push(`- ${f.explanation}`, '');
    }
  }
  return lines.join('\n');
}

export function printCheck(result: CheckResult, json = false): void {
  if (json) {
    log.info(JSON.stringify(reportToJson(result), null, 2));
  } else {
    printCheckReport(result);
  }
}
