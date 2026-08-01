export { loadCorpus, type LoadedCorpus } from './load.js';
export { chunkText, chunkCorpus, type TextChunk, type ChunkOptions } from './chunk.js';
export {
  extractClaimsFromChunk,
  extractClaimsFromChunks,
  filterProvenancedClaims,
  evidenceInChunk,
  EXTRACT_INSTRUCTIONS,
  EXTRACT_JSON_SCHEMA,
  ExtractedClaimSchema,
  type ExtractedClaim,
  type ExtractResult,
} from './extract.js';
export { resolveEntity, type ResolveInput, type ResolveResult } from './resolve.js';
