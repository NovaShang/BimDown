/**
 * The type a placement tool starts with (Revit: the last type used for that
 * category, else the first in the catalog). Projects whose types are not
 * written yet (the starter catalog is only offered) start untyped, as before.
 */
import { findType, retypeAttrs, typesForInstanceTable, type TypeCatalog } from './catalog.ts';

const STORE_KEY = 'bimdown:lastTypes';
let lastUsed: Map<string, string> | null = null;

/** Last type per category, kept across sessions (localStorage; memory only where unavailable). */
function store(): Map<string, string> {
  if (lastUsed) return lastUsed;
  lastUsed = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) if (typeof v === 'string') lastUsed.set(k, v);
  } catch { /* unavailable or corrupt: start empty */ }
  return lastUsed;
}

/** Remember the type last used for a category: picked for its placement tool or given to an element. */
export function rememberDrawingType(instanceTable: string, typeId: string): void {
  const m = store();
  m.set(instanceTable, typeId);
  try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(m))); } catch { /* quota / private mode */ }
}

/** Drawing attrs for `typeId`: type_id plus the type's parameter values. */
export function drawingAttrsForType(
  instanceTable: string,
  attrs: Record<string, string>,
  typeId: string,
  catalog: TypeCatalog | undefined,
): Record<string, string> {
  if (!typeId) {
    const next = { ...attrs };
    delete next.type_id;
    return next;
  }
  return retypeAttrs(instanceTable, attrs, typeId, catalog);
}

export function withDefaultDrawingType(
  instanceTable: string,
  attrs: Record<string, string>,
  catalog: TypeCatalog | undefined,
): Record<string, string> {
  // A tool variant that fixes the kind (pad / pile / strip foundation) starts with a type of that kind.
  const fits = (t: { values: Record<string, string> }) => !attrs.kind || !t.values.kind || t.values.kind === attrs.kind;
  const candidates = typesForInstanceTable(catalog, instanceTable).filter(fits);
  if (candidates.length === 0) return attrs;
  const remembered = store().get(instanceTable);
  if (remembered === '') return attrs; // the user chose "no type" for this tool
  const r = remembered ? findType(catalog, remembered) : undefined;
  const t = (r && fits(r) ? r : undefined) || (catalog?.saved ? candidates[0] : undefined);
  return t ? drawingAttrsForType(instanceTable, attrs, t.id, catalog) : attrs;
}
