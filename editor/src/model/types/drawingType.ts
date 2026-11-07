/**
 * The type a placement tool starts with (Revit: the last type used for that
 * category, else the first in the catalog). Projects whose types are not
 * written yet (the starter catalog is only offered) start untyped, as before.
 */
import { findType, retypeAttrs, typesForInstanceTable, type TypeCatalog } from './catalog.ts';

const lastUsed = new Map<string, string>();

/** Remember the type picked for a table's placement tool (session only). */
export function rememberDrawingType(instanceTable: string, typeId: string): void {
  lastUsed.set(instanceTable, typeId);
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
  const candidates = typesForInstanceTable(catalog, instanceTable);
  if (candidates.length === 0) return attrs;
  const remembered = lastUsed.get(instanceTable);
  if (remembered === '') return attrs; // the user chose "no type" for this tool
  const t = (remembered && findType(catalog, remembered)) || (catalog?.saved ? candidates[0] : undefined);
  return t ? drawingAttrsForType(instanceTable, attrs, t.id, catalog) : attrs;
}
