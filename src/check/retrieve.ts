import type { Db } from '../db/index.js';
import { findCandidateClaims, type CitedClaim } from '../db/repo.js';
import { DEFAULT_BRANCH } from '../db/types.js';

/**
 * Retrieve canon candidates for a draft claim on a known entity.
 * Exact attribute first, then other canon claims on the entity.
 */
export function retrieveCandidates(
  db: Db,
  entityId: number,
  attribute: string,
): CitedClaim[] {
  return findCandidateClaims(db, {
    entityId,
    attribute,
    branch: DEFAULT_BRANCH,
    status: 'canon',
  });
}
