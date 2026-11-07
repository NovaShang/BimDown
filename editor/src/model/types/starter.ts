/**
 * Built-in starter type catalog that new projects get (files in starterFiles.mjs,
 * identical to bimdown-spec/spec/starter-types/global/*.csv).
 */
import { parseTypeFiles, type TypeCatalog } from './catalog.ts';
import { STARTER_TYPE_FILES } from './starterFiles.mjs';

export { STARTER_TYPE_FILES };

/** The starter catalog, not yet written to the project (`saved: false`). */
export function starterCatalog(): TypeCatalog {
  return { types: parseTypeFiles(STARTER_TYPE_FILES), saved: false };
}
