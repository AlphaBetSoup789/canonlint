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
}

function printFinding(finding: CheckFinding, draftPath: string): void {
  log.info(`  ${finding.summary}`);
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
  log.info(style.bold(`${title} (${findings.length})`));
  log.info('');
  if (findings.length === 0) {
    log.detail('none');
    log.info('');
    return;
  }
  for (const finding of findings) {
    printFinding(finding, draftPath);
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
    usage: report.usage,
  };
}
