/**
 * Copy / paste of elements through the system clipboard: JSON text with a
 * BimDown marker, so a copy can go to another level, another project or
 * another browser tab. The copy carries the selection plus what depends on
 * it (doors, ports, tags, dimensions, group members — see copySet.ts) in
 * the editor's element form, with the source level list (to re-target top
 * constraints) and the project unit (pasting across units is refused).
 */
import type { CanonicalElement, Point } from './elements.ts';
import type { Level, ProjectUnit } from '../types.ts';
import type { TypeCatalog } from './types/catalog.ts';
import { expandCopySet, cloneElements, retargetLevelAttrs, type NumberPool } from './copySet.ts';
import { elementsBounds, boundsCenter, transformElements, translation } from './transform.ts';

export const CLIPBOARD_MARKER = 'bimdown/elements';

export interface ClipboardPayload {
  bimdown: typeof CLIPBOARD_MARKER;
  version: 1;
  /** Source project (model name) and level. */
  project: string;
  levelId: string;
  levels: Level[];
  units: ProjectUnit;
  /** Paste-at-cursor base point (centre of the copied extent). */
  base: Point;
  /** The copied selection (top-level ids) and every element that travels with it. */
  selected: string[];
  elements: CanonicalElement[];
}

export function buildClipboard(
  elements: ReadonlyMap<string, CanonicalElement>,
  selectedRaw: Iterable<string>,
  ctx: { project: string; levelId: string; levels: Level[]; units: ProjectUnit },
): ClipboardPayload | null {
  const selected = [...selectedRaw].filter(id => elements.has(id) && elements.get(id)!.tableName !== 'grid');
  if (selected.length === 0) return null;
  const set = expandCopySet(elements, selected);
  const list = [...set].map(id => elements.get(id)!).filter(el => el.tableName !== 'grid');
  const b = elementsBounds(list);
  return {
    bimdown: CLIPBOARD_MARKER, version: 1,
    project: ctx.project, levelId: ctx.levelId, levels: ctx.levels, units: ctx.units,
    base: b ? boundsCenter(b) : { x: 0, y: 0 },
    selected,
    elements: list,
  };
}

export function serializeClipboard(p: ClipboardPayload): string {
  return JSON.stringify(p);
}

export function parseClipboard(text: string | null | undefined): ClipboardPayload | null {
  if (!text || !text.includes(CLIPBOARD_MARKER)) return null;
  try {
    const p = JSON.parse(text);
    if (p?.bimdown !== CLIPBOARD_MARKER || !Array.isArray(p.elements)) return null;
    return p as ClipboardPayload;
  } catch {
    return null;
  }
}

/**
 * The payload's elements as copies for `levelId` (fresh ids among `taken`),
 * moved by `offset`. Types the target project lacks are dropped (the values
 * stay on the elements).
 */
export function pasteElements(
  p: ClipboardPayload,
  levelId: string,
  levels: readonly Level[],
  taken: Set<string>,
  offset: Point,
  types?: TypeCatalog,
  numbers?: NumberPool,
  /** Grid names of the target project (pasted grids take the next free ones). */
  gridNames?: Set<string>,
): { elements: CanonicalElement[]; selected: string[] } {
  const source = new Map(p.elements.map(e => [e.id, e]));
  const { clones, idMap } = cloneElements(source, source.keys(), { taken, numbers, gridNames });
  const placed = transformElements(clones, clones.keys(), translation(offset.x, offset.y));
  const typeIds = new Set((types?.types ?? []).map(t => t.id));
  const sameLevels = p.levels.every(l => levels.some(m => m.id === l.id));
  const out: CanonicalElement[] = [];
  for (const el of placed.values()) {
    let attrs = sameLevels ? retargetLevelAttrs(el.attrs, p.levelId, levelId, levels) : dropLevelRefs(el.attrs, levelId);
    if (attrs.type_id && !typeIds.has(attrs.type_id)) attrs = { ...attrs, type_id: '' };
    out.push(attrs === el.attrs ? el : { ...el, attrs });
  }
  const selected = p.selected.map(id => idMap.get(id)).filter((x): x is string => !!x);
  return { elements: out, selected };
}

/** The pasted elements use types of a starter catalog not written to the project yet. */
export function pasteNeedsTypesSaved(p: ClipboardPayload, types?: TypeCatalog): boolean {
  if (!types || types.saved) return false;
  return p.elements.some(e => e.attrs.type_id && types.types.some(t => t.id === e.attrs.type_id));
}

/** From another project: level references can't carry over. */
function dropLevelRefs(attrs: Record<string, string>, levelId: string): Record<string, string> {
  const next = { ...attrs };
  if ('level_id' in next) next.level_id = levelId;
  if (next.base_level_id) next.base_level_id = levelId;
  if (next.top_level_id) next.top_level_id = '';
  return next;
}

// In-memory copy: Paste works even where the system clipboard can't be read.
let memory: ClipboardPayload | null = null;

export function rememberClipboard(p: ClipboardPayload | null): void {
  memory = p;
}

export function rememberedClipboard(): ClipboardPayload | null {
  return memory;
}
