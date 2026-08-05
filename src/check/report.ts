import type { ConflictKind, Severity } from '../db/types.js';
import type { ExtractedClaim } from '../ingest/extract.js';
import type { TokenUsage } from '../llm/types.js';
import { formatUsd } from '../llm/pricing.js';
import { log, style } from '../util/logger.js';

export interface CheckFinding {
  kind: ConflictKind;
  severity: Severity;
  summary: string;
  explanation: string;
  draft: {
    path: string;
    locator: string;
    quote: string;
    claim: ExtractedClaim;
  };
  canon?: {
    claimId: number;
    workTitle: string;
    locator: string;
    excerpt: string;
  };
}

export interface ClusteredFinding {
  /** Representative finding (first occurrence). */
  finding: CheckFinding;
  /** entity_name + attribute key. */
  key: string;
  occurrences: number;
}

export interface CheckReport {
  runId: number;
  draftPath: string;
  contradictions: CheckFinding[];
  timeline: CheckFinding[];
  newFacts: CheckFinding[];
  uncertain: CheckFinding[];
  claimsChecked: number;
  entitiesUnresolved: number;
  usage: TokenUsage;
  estimatedUsd: number;
  actualUsd: number;
  model: string;
  provider: string;
  warnings: string[];
  /** Entities whose claims span suspiciously many works (M3.5 anomaly). */
  entityAnomalies?: { name: string; kind: string; workCount: number }[];
}

/**
 * Group findings by (entity_name, attribute) so repeated magnets collapse
 * to one row with an occurrence count.
 */
export function clusterFindings(findings: CheckFinding[]): ClusteredFinding[] {
  const order: string[] = [];
  const map = new Map<string, ClusteredFinding>();
  for (const finding of findings) {
    const entity = finding.draft.claim.entity_name;
    const attr = finding.draft.claim.attribute;
    const key = `${entity.toLowerCase()}::${attr.toLowerCase()}`;
    const existing = map.get(key);
    if (existing) {
      existing.occurrences += 1;
    } else {
      order.push(key);
      map.set(key, { finding, key, occurrences: 1 });
    }
  }
  return order.map((k) => map.get(k)!);
}

function printFinding(finding: CheckFinding, draftPath: string, occurrences = 1): void {
  const suffix = occurrences > 1 ? ` (${occurrences} occurrences)` : '';
  log.info(`  ${finding.summary}${suffix}`);
  if (finding.canon) {
    log.info(
      `    canon   ${finding.canon.workTitle}, ${finding.canon.locator} — ` +
        `"${finding.canon.excerpt}"`,
    );
  }
  log.info(
    `    draft   ${draftPath}:${finding.draft.locator} — "${finding.draft.quote}"`,
  );
  log.detail(finding.explanation);
  log.info('');
}

function section(title: string, findings: CheckFinding[], draftPath: string): void {
  const clustered = clusterFindings(findings);
  log.info(style.bold(`${title} (${clustered.length} distinct, ${findings.length} raw)`));
  log.info('');
  if (clustered.length === 0) {
    log.detail('none');
    log.info('');
    return;
  }
  for (const cluster of clustered) {
    printFinding(cluster.finding, draftPath, cluster.occurrences);
  }
}

export function printCheckReport(report: CheckReport): void {
  log.info('');
  log.info(style.bold(`canonlint check ${report.draftPath}`));
  log.detail(
    `${report.claimsChecked} draft claim(s) checked via ${report.provider}/${report.model}`,
  );
  log.info('');

  section('Contradictions', report.contradictions, report.draftPath);
  section('Timeline issues', report.timeline, report.draftPath);
  section('New facts', report.newFacts, report.draftPath);
  section('Uncertain', report.uncertain, report.draftPath);

  log.info(
    `cost ${formatUsd(report.actualUsd)} actual ` +
      `(estimated ${formatUsd(report.estimatedUsd)})`,
  );
  if (report.entitiesUnresolved > 0) {
    log.detail(
      `${report.entitiesUnresolved} draft claim(s) referenced unknown entities ` +
        '(treated as new facts / skipped for contradiction).',
    );
  }
  if (report.entityAnomalies && report.entityAnomalies.length > 0) {
    log.warn(
      `${report.entityAnomalies.length} entit(y/ies) span >8 works — review before trusting the report:`,
    );
    for (const a of report.entityAnomalies) {
      log.warn(`  ${a.name} (${a.kind}): ${a.workCount} works`);
    }
  }
  for (const warning of report.warnings) {
    log.warn(warning);
  }
  if (report.newFacts.length > 0) {
    log.info('');
    log.detail(`canonlint merge ${report.draftPath}   promote new facts into canon`);
  }
}

export function reportToJson(report: CheckReport): unknown {
  return {
    runId: report.runId,
    draftPath: report.draftPath,
    contradictions: report.contradictions,
    contradictionsClustered: clusterFindings(report.contradictions),
    timeline: report.timeline,
    newFacts: report.newFacts,
    uncertain: report.uncertain,
    claimsChecked: report.claimsChecked,
    entitiesUnresolved: report.entitiesUnresolved,
    estimatedUsd: report.estimatedUsd,
    actualUsd: report.actualUsd,
    model: report.model,
    provider: report.provider,
    warnings: report.warnings,
    entityAnomalies: report.entityAnomalies ?? [],
    usage: report.usage,
  };
}
