import type { CheckFinding, CheckReport } from '../../src/check/report.js';
import type { HolmesWork } from './manifest.js';
import { KNOWN_ERROR_PATTERNS, knownPatternsForFinding } from './knownErrors.js';

export interface HolmesStoryEntry {
  work: HolmesWork;
  checked: boolean;
  ingested: boolean;
  skipped: boolean;
  skipReason?: string;
  report?: CheckReport;
}

export interface HolmesAccumulatedReport {
  storiesTotal: number;
  storiesChecked: number;
  storiesIngested: number;
  storiesSkipped: number;
  contradictions: number;
  timeline: number;
  newFacts: number;
  uncertain: number;
  stories: HolmesStoryEntry[];
  findings: Array<
    CheckFinding & { workId: string; storyTitle: string; storyOrder: number }
  >;
}

export function createEmptyAccumulatedReport(
  works: HolmesWork[],
): HolmesAccumulatedReport {
  return {
    storiesTotal: works.length,
    storiesChecked: 0,
    storiesIngested: 0,
    storiesSkipped: 0,
    contradictions: 0,
    timeline: 0,
    newFacts: 0,
    uncertain: 0,
    stories: works.map((work) => ({
      work,
      checked: false,
      ingested: false,
      skipped: false,
    })),
    findings: [],
  };
}

function pushFindings(
  acc: HolmesAccumulatedReport,
  work: HolmesWork,
  findings: CheckFinding[],
): void {
  for (const finding of findings) {
    acc.findings.push({
      ...finding,
      workId: work.id,
      storyTitle: work.title,
      storyOrder: work.order,
    });
  }
}

export function markStorySkipped(
  acc: HolmesAccumulatedReport,
  work: HolmesWork,
  reason: string,
): void {
  const entry = acc.stories.find((s) => s.work.id === work.id);
  if (!entry) return;
  entry.skipped = true;
  entry.skipReason = reason;
  acc.storiesSkipped += 1;
}

export function accumulateCheckReport(
  acc: HolmesAccumulatedReport,
  work: HolmesWork,
  report: CheckReport,
): void {
  const entry = acc.stories.find((s) => s.work.id === work.id);
  if (!entry) return;

  entry.checked = true;
  entry.report = report;
  acc.storiesChecked += 1;
  acc.contradictions += report.contradictions.length;
  acc.timeline += report.timeline.length;
  acc.newFacts += report.newFacts.length;
  acc.uncertain += report.uncertain.length;

  pushFindings(acc, work, report.contradictions);
  pushFindings(acc, work, report.timeline);
  // New facts / uncertain are counted above but omitted from the published
  // findings list — the demo report is about Doyle contradicting Doyle.
}

export function markStoryIngested(
  acc: HolmesAccumulatedReport,
  work: HolmesWork,
): void {
  const entry = acc.stories.find((s) => s.work.id === work.id);
  if (!entry) return;
  entry.ingested = true;
  acc.storiesIngested += 1;
}

function renderFinding(f: HolmesAccumulatedReport['findings'][number]): string[] {
  const lines = [`#### ${f.summary}`, ''];
  if (f.canon) {
    lines.push(
      `- **canon** ${f.canon.workTitle}, ${f.canon.locator} — "${f.canon.excerpt}"`,
    );
  }
  lines.push(`- **draft** ${f.storyTitle}, ${f.draft.locator} — "${f.draft.quote}"`);
  lines.push(`- ${f.explanation}`, '');
  return lines;
}

/**
 * Render the Holmes continuity report: fun narrative for known patterns,
 * then every cited contradiction. New-fact noise is summarised as a count.
 */
export function renderHolmesContinuityMarkdown(acc: HolmesAccumulatedReport): string {
  const contradictions = acc.findings.filter((f) => f.kind === 'contradiction');
  const timeline = acc.findings.filter((f) => f.kind === 'timeline');

  const lines: string[] = [
    '# Doyle vs Doyle: a Holmes continuity report',
    '',
    'What happens when you feed all sixty Sherlock Holmes stories to a',
    'continuity linter, in the order Doyle published them, and ask it to',
    'complain every time a new story contradicts the ones that came before?',
    '',
    'This is that experiment. Public-domain text from',
    '[Project Gutenberg](https://www.gutenberg.org/); short excerpts only.',
    'Built with [canonlint](https://github.com/AlphaBetSoup789/canonlint).',
    '',
    '## How this was produced',
    '',
    '1. Ingest each story into a local canon database in publication order.',
    '2. Before ingesting story *n*, run `canonlint check` against stories 1…*n−1*.',
    '3. Keep every contradiction that can cite a real canon excerpt',
    '   (precision over recall — uncertain calls stay out of this list).',
    '',
    'This checked-in report was regenerated with the deterministic Holmes mock',
    'provider (`npm run demo:holmes`) — **$0 model spend**. A live Anthropic',
    'ingest of the same ~650k-word corpus is the single-digit-to-low-double-digit',
    'dollar estimate from the README; swap `CANONLINT_PROVIDER=anthropic` when',
    'you want the model, not the agent, to extract claims.',
    '',
    '## Scoreboard',
    '',
    `| | |`,
    `| --- | ---: |`,
    `| Stories ingested | ${acc.storiesIngested} |`,
    `| Checks run | ${acc.storiesChecked} |`,
    `| Contradictions with citations | ${contradictions.length} |`,
    `| Timeline issues | ${timeline.length} |`,
    `| New facts (not listed below) | ${acc.newFacts} |`,
    `| Uncertain (routed away from Contradictions) | ${acc.uncertain} |`,
    '',
  ];

  const narrativeFindings = new Map<string, HolmesAccumulatedReport['findings']>();
  for (const finding of contradictions.concat(timeline)) {
    for (const pattern of knownPatternsForFinding(finding)) {
      const bucket = narrativeFindings.get(pattern.id) ?? [];
      bucket.push(finding);
      narrativeFindings.set(pattern.id, bucket);
    }
  }

  lines.push('## The hits', '');
  if (narrativeFindings.size === 0 && contradictions.length === 0) {
    lines.push(
      '_No hard contradictions survived the precision gate. Either Doyle had a_',
      '_quiet day, or the claim extractors were too polite._',
      '',
    );
  } else {
    for (const pattern of KNOWN_ERROR_PATTERNS) {
      const bucket = narrativeFindings.get(pattern.id);
      if (!bucket || bucket.length === 0) continue;
      lines.push(`### ${pattern.title}`, '', pattern.blurb, '');
      for (const f of bucket) {
        lines.push(...renderFinding(f));
      }
    }

    const narrated = new Set([...narrativeFindings.values()].flat().map((f) => f));
    const other = contradictions.filter((f) => !narrated.has(f));
    if (other.length > 0) {
      lines.push('### Other cited contradictions', '');
      lines.push(
        'Not every Doyle slip is famous. These still cleared the precision',
        'gate — each one cites a real earlier excerpt.',
        '',
      );
      for (const f of other) {
        lines.push(...renderFinding(f));
      }
    }
  }

  if (timeline.length > 0) {
    lines.push('## Timeline issues', '');
    for (const f of timeline) {
      lines.push(...renderFinding(f));
    }
  }

  lines.push(
    '## Appendix: per-story check counts',
    '',
    '| # | Story | Contradictions |',
    '| ---: | --- | ---: |',
  );
  for (const entry of acc.stories) {
    if (!entry.checked || !entry.report) continue;
    lines.push(
      `| ${entry.work.order} | ${entry.work.title} | ${entry.report.contradictions.length} |`,
    );
  }
  lines.push('');

  if (acc.storiesSkipped > 0) {
    lines.push('## Skipped stories', '');
    for (const entry of acc.stories) {
      if (!entry.skipped) continue;
      lines.push(
        `- **${entry.work.title}** (\`${entry.work.id}\`): ${entry.skipReason ?? 'skipped'}`,
      );
    }
    lines.push('');
  }

  lines.push(
    '---',
    '',
    '_Corpus: Arthur Conan Doyle, public domain in the US. Last US-copyrighted_',
    '_Holmes stories entered the public domain in 2023. Sources via Project Gutenberg._',
    '',
  );

  return lines.join('\n');
}
