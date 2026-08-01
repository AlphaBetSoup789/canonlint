import { loadConfig, type ConfigOverrides } from '../config.js';
import { openDb } from '../db/index.js';
import {
  findCitedClaims,
  findEntityByNameOrAlias,
  getEntityAliases,
  type CitedClaim,
} from '../db/repo.js';
import type { Entity } from '../db/types.js';
import { requireProject } from '../paths.js';
import { CanonlintError } from '../util/errors.js';
import { log, style } from '../util/logger.js';

export interface EntityOptions extends ConfigOverrides {
  name: string;
  cwd?: string;
  json?: boolean;
}

export interface EntityResult {
  entity: Entity;
  aliases: string[];
  claims: CitedClaim[];
}

export function runEntity(options: EntityOptions): EntityResult {
  const paths = requireProject(options.cwd);
  // Touch config so --provider/--model stay consistent with other commands
  // even though entity is a pure DB read.
  loadConfig(paths, options);

  const db = openDb(paths.dbPath, { mustExist: true });
  try {
    const entity = findEntityByNameOrAlias(db, options.name);
    if (!entity) {
      throw new CanonlintError(
        `No entity matching "${options.name}". ` +
          `Try \`canonlint stats\` to see what is in the database.`,
      );
    }
    const aliases = getEntityAliases(entity);
    const claims = findCitedClaims(db, { entityId: entity.id });
    return { entity, aliases, claims };
  } finally {
    db.close();
  }
}

export function printEntity(result: EntityResult): void {
  const { entity, aliases, claims } = result;
  log.info(style.bold(entity.name));
  log.info(`  kind       ${entity.kind}`);
  log.info(
    `  aliases    ${aliases.length > 0 ? aliases.join(', ') : style.dim('(none)')}`,
  );
  log.info(`  claims     ${claims.length}`);
  log.info('');

  if (claims.length === 0) {
    log.detail('No claims recorded for this entity yet.');
    return;
  }

  for (const claim of claims) {
    log.info(
      `${style.bold(`${claim.attribute}`)} = ${claim.value} ` +
        style.dim(`(${claim.modality}, ${claim.status}, conf ${claim.confidence})`),
    );
    log.detail(`${claim.work_title}, ${claim.locator}`);
    log.detail(`"${claim.text_excerpt}"`);
    log.info('');
  }
}
