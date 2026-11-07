/**
 * Reducer helpers for element types: re-resolving every element when the
 * catalog changes, and switching elements to another type. Elements keep
 * effective values in memory (model/types/catalog.ts), so a catalog change
 * rewrites the in-memory attrs of every element that follows a changed type —
 * in the open document, the other levels and global/.
 */
import type { CanonicalElement, LineElement, PointElement } from '../model/elements.ts';
import type { LayerData, ProjectData } from '../types.ts';
import type { EditorState } from './editorTypes.ts';
import { resolveHostedGeometry } from '../geometry/hosted.ts';
import { arcLength } from '../geometry/arc.ts';
import {
  isTypedTable,
  reresolveTypeAttrs,
  retypeAttrs,
  type TypeCatalog,
} from '../model/types/catalog.ts';

/**
 * `el` with new attrs and the geometry fields derived from them kept in sync:
 * line thickness → strokeWidth, point size_x/size_y → width/height, a hosted
 * opening's width → its span on the host (looked up in `elements`).
 */
export function withSyncedAttrs(
  el: CanonicalElement,
  attrs: Record<string, string>,
  elements: Map<string, CanonicalElement>,
): CanonicalElement {
  const next = { ...el, attrs } as CanonicalElement;
  if (next.geometry === 'line' || next.geometry === 'spatial_line') {
    const t = parseFloat(attrs.thickness);
    if (Number.isFinite(t) && t > 0 && attrs.thickness !== el.attrs.thickness) (next as LineElement).strokeWidth = t;
  }
  if (next.geometry === 'point') {
    const pt = next as PointElement;
    if (attrs.size_x !== el.attrs.size_x) pt.width = parseFloat(attrs.size_x) || pt.width;
    if (attrs.size_y !== el.attrs.size_y) pt.height = parseFloat(attrs.size_y) || pt.height;
  }
  if (next.hostId && next.geometry === 'line' && attrs.width !== el.attrs.width) {
    const host = elements.get(next.hostId);
    if (host && (host.geometry === 'line' || host.geometry === 'spatial_line')) {
      const pos = parseFloat(attrs.position ?? '0.5');
      const width = parseFloat(attrs.width ?? '0.9');
      const { start, end } = resolveHostedGeometry(host as LineElement, pos, width);
      (next as LineElement).start = start;
      (next as LineElement).end = end;
    }
  }
  return next;
}

/** Document elements re-resolved for a catalog change. Only changed elements appear in `changed`. */
export function reresolveElements(
  elements: Map<string, CanonicalElement>,
  before: TypeCatalog | undefined,
  after: TypeCatalog | undefined,
): { next: Map<string, CanonicalElement>; changed: Map<string, { before: CanonicalElement; after: CanonicalElement }> } {
  const changed = new Map<string, { before: CanonicalElement; after: CanonicalElement }>();
  const next = new Map(elements);
  for (const [id, el] of elements) {
    if (!el.attrs.type_id || !isTypedTable(el.tableName)) continue;
    const attrs = reresolveTypeAttrs(el.tableName, el.attrs, before, after);
    if (attrs === el.attrs) continue;
    // A type never moves a host's line, so hosted spans resolve against it as is.
    const updated = withSyncedAttrs(el, attrs, elements);
    next.set(id, updated);
    changed.set(id, { before: el, after: updated });
  }
  return { next, changed };
}

function reresolveLayer(layer: LayerData, before: TypeCatalog | undefined, after: TypeCatalog | undefined): LayerData {
  if (!isTypedTable(layer.tableName)) return layer;
  let rows: Map<string, Record<string, string>> | null = null;
  for (const [id, row] of layer.csvRows) {
    const next = reresolveTypeAttrs(layer.tableName, row, before, after);
    if (next === row) continue;
    rows ??= new Map(layer.csvRows);
    rows.set(id, next);
  }
  return rows ? { ...layer, csvRows: rows } : layer;
}

/** Project with the new catalog and every level / global layer re-resolved against it. */
export function reresolveProject(project: ProjectData, after: TypeCatalog): ProjectData {
  const before = project.types;
  const floors = new Map(project.floors);
  for (const [levelId, floor] of project.floors) {
    const layers = floor.layers.map(l => reresolveLayer(l, before, after));
    if (layers.some((l, i) => l !== floor.layers[i])) floors.set(levelId, { ...floor, layers });
  }
  const globalLayers = project.globalLayers.map(l => reresolveLayer(l, before, after));
  return { ...project, floors, globalLayers, types: after };
}

/** Switch `ids` to `typeId` ('' = no type); returns before/after of the elements that changed. */
export function retypeElements(
  elements: Map<string, CanonicalElement>,
  ids: string[],
  typeId: string,
  catalog: TypeCatalog | undefined,
): { next: Map<string, CanonicalElement>; changed: Map<string, { before: CanonicalElement; after: CanonicalElement }> } {
  const next = new Map(elements);
  const changed = new Map<string, { before: CanonicalElement; after: CanonicalElement }>();
  for (const id of ids) {
    const el = elements.get(id);
    if (!el || !isTypedTable(el.tableName)) continue;
    if ((el.attrs.type_id ?? '') === typeId) continue;
    const updated = withSyncedAttrs(el, retypeAttrs(el.tableName, el.attrs, typeId, catalog), next);
    next.set(id, updated);
    changed.set(id, { before: el, after: updated });
  }
  return { next, changed };
}

const FLIPPABLE = new Set(['wall', 'structure_wall']);

/** Whether every element is a wall whose exterior side can be flipped. */
export function canFlipWalls(els: (CanonicalElement | null | undefined)[]): boolean {
  return els.length > 0 && els.every(el => !!el && FLIPPABLE.has(el.tableName) && el.geometry === 'line');
}

/**
 * Flip walls end for end so their layers face the other way (Revit's flip
 * arrows; layer seq 1 sits on a wall's left): start ↔ end, an arc keeps its
 * shape with the opposite sweep, and every opening on them stays in place —
 * position measured from the new start, a door's hinge and swing mirrored.
 * Returns the changed elements.
 */
export function flipWalls(elements: Map<string, CanonicalElement>, ids: string[]): Map<string, CanonicalElement> {
  const patches = new Map<string, CanonicalElement>();
  for (const id of ids) {
    const el = elements.get(id);
    if (!el || !FLIPPABLE.has(el.tableName) || el.geometry !== 'line') continue;
    const w = el as LineElement;
    const flipped: LineElement = { ...w, start: w.end, end: w.start, ...(w.arc ? { arc: { ...w.arc, sweep: !w.arc.sweep } } : {}) };
    patches.set(id, flipped);
    const len = w.arc ? arcLength(w.start, w.end, w.arc) : Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    for (const [hid, h] of elements) {
      if ((h.hostId || h.attrs.host_id) !== id || h.geometry !== 'line') continue;
      const pos = parseFloat(h.attrs.position ?? '');
      if (!Number.isFinite(pos)) continue;
      const position = Math.max(0, len - pos);
      const attrs: Record<string, string> = { ...h.attrs, position: String(+position.toFixed(4)) };
      if (h.tableName === 'door') {
        attrs.hinge_position = attrs.hinge_position === 'end' ? 'start' : 'end';
        attrs.swing_side = attrs.swing_side === 'right' ? 'left' : 'right';
      }
      const { start, end } = resolveHostedGeometry(flipped, position, parseFloat(attrs.width ?? '0.9') || 0.9);
      patches.set(hid, { ...(h as LineElement), attrs, start, end, locationParam: position });
    }
  }
  return patches;
}

/** Elements using `typeId` in the whole project (open document + other levels + global/). */
export function countTypeUsage(state: EditorState, typeId: string): number {
  if (!typeId) return 0;
  let n = 0;
  const docLevel = state.document?.levelId;
  if (state.document) for (const el of state.document.elements.values()) if (el.attrs.type_id === typeId) n++;
  for (const [levelId, floor] of state.project?.floors ?? []) {
    if (levelId === docLevel) continue;
    for (const l of floor.layers) for (const row of l.csvRows.values()) if (row.type_id === typeId) n++;
  }
  for (const l of state.project?.globalLayers ?? []) for (const row of l.csvRows.values()) if (row.type_id === typeId) n++;
  return n;
}
