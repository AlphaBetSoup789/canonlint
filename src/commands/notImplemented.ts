import { CanonlintError } from '../util/errors.js';

/**
 * The v1 CLI surface is fixed from M0 so the shape of the tool is stable while
 * the pipelines land. These commands are declared, documented, and reachable —
 * they just refuse cleanly instead of half-working.
 */
const MILESTONES: Record<string, string> = {
  ingest: 'M1',
  check: 'M2',
  merge: 'M2',
  entity: 'M1',
};

export function notImplemented(command: string): never {
  const milestone = MILESTONES[command];
  throw new CanonlintError(
    `\`canonlint ${command}\` is not implemented yet` +
      (milestone ? ` — it lands in ${milestone}.` : '.') +
      `\nSee the roadmap in the README for what works today.`,
  );
}
