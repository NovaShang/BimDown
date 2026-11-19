/**
 * Built-in starter type catalog that new projects get (files in starterFiles.mjs,
 * identical to spec/starter-types/global/*.csv). The files are
 * metric; the catalog is scaled to the project's units.
 */
import { parseTypeFiles, type ElementType, type TypeCatalog } from './catalog.ts';
import { STARTER_TYPE_FILES } from './starterFiles.mjs';

export { STARTER_TYPE_FILES };

/** Type parameters that are lengths (scaled with the project units). */
const LENGTH_PARAMS = new Set(['thickness', 'width', 'length', 'height', 'frame_width', 'u_spacing', 'v_spacing', 'size_x', 'size_y', 'flange', 'web', 'root_radius']);

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function scaleType(t: ElementType, upm: number): ElementType {
  if (upm === 1) return t;
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.values)) {
    const n = parseFloat(v);
    values[k] = LENGTH_PARAMS.has(k) && v.trim() !== '' && Number.isFinite(n) ? String(round6(n * upm)) : v;
  }
  return { ...t, values, layers: t.layers.map(l => ({ ...l, thickness: round6(l.thickness * upm) })) };
}

/** The starter types in project units (`upm` model units per metre). */
export function starterTypes(upm = 1): ElementType[] {
  return parseTypeFiles(STARTER_TYPE_FILES).map(t => scaleType(t, upm));
}

/** The starter catalog, not yet written to the project (`saved: false`). */
export function starterCatalog(upm = 1): TypeCatalog {
  return { types: starterTypes(upm), saved: false };
}

/**
 * The catalog plus the starter types of `table` it lacks (by id), or null when
 * none is missing. Existing rows are left as they are.
 */
export function withStarterTypes(catalog: TypeCatalog, table: string, upm = 1): TypeCatalog | null {
  const have = new Set(catalog.types.map(t => t.id));
  const missing = starterTypes(upm).filter(t => t.table === table && !have.has(t.id));
  if (!missing.length) return null;
  return { ...catalog, types: [...catalog.types, ...missing] };
}
