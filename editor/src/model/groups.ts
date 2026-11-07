/**
 * Model groups (spec csv-schema/model_group.yaml): a `model_group` row per
 * instance (origin x, y, rotation, mirrored) on a level; members are ordinary
 * elements of that level with `group_id` = the row id. Instances sharing a
 * `name` are copies of one group.
 *
 *   createGroup   — selection → one instance (origin at the selection centre)
 *   ungroupPatch  — delete the row, clear the members' group_id
 *   propagateGroupEdit — after an instance was edited, rebuild every other
 *                   instance from it, keeping the ids of members that match
 *                   (same element in the group's local frame) so tags and
 *                   dimensions on them survive.
 */
import type { CanonicalElement, PointElement, Point } from './elements.ts';
import { ANNOTATION_TABLES } from '../annotation/model.ts';
import { parseRef } from '../annotation/geometry.ts';
import { generateId } from './ids.ts';
import { cloneElements, expandCopySet, groupMembers } from './copySet.ts';
import {
  boundsCenter, compose, elementsBounds, invert, mirrorAcross, rotationAbout, transformElements, translation, type Xform,
} from './transform.ts';

export const GROUP_TABLE = 'model_group';

/** Tables that can't be group members (annotations live on the plan, ports ride on their host). */
export function isGroupable(el: CanonicalElement): boolean {
  return !ANNOTATION_TABLES.has(el.tableName) && el.tableName !== 'connector' && el.tableName !== GROUP_TABLE
    && el.tableName !== 'grid' && el.tableName !== 'mep_node';
}

/** Instance frame: plan = origin + R(rotation) · (mirrored ? flipY : I) · local. */
export function groupTransform(row: CanonicalElement): Xform {
  const p = row.geometry === 'point' ? row.position : { x: parseFloat(row.attrs.x) || 0, y: parseFloat(row.attrs.y) || 0 };
  const rot = parseFloat(row.attrs.rotation ?? '') || 0;
  let T = compose(translation(p.x, p.y), rotationAbout({ x: 0, y: 0 }, rot));
  if (row.attrs.mirrored === 'true') T = compose(T, mirrorAcross({ x: 0, y: 0 }, { x: 1, y: 0 }));
  return T;
}

export function groupRow(id: string, name: string, at: Point, discipline = 'annotation'): PointElement {
  return {
    geometry: 'point', id, tableName: GROUP_TABLE, discipline,
    position: { x: at.x, y: at.y }, width: 0.4, height: 0.4,
    attrs: { id, name, x: String(round(at.x)), y: String(round(at.y)), rotation: '0', mirrored: '' },
  };
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Next free "Group N" name. */
export function nextGroupName(elements: Iterable<CanonicalElement>, base = 'Group'): string {
  const names = new Set<string>();
  for (const el of elements) if (el.tableName === GROUP_TABLE) names.add(el.attrs.name ?? '');
  let n = 1;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * Patch creating a group of `ids` (raw ids; hosted children come along).
 * Members already in another group leave it. Returns null when nothing groupable.
 */
export function createGroupPatch(
  elements: ReadonlyMap<string, CanonicalElement>,
  ids: Iterable<string>,
  name: string,
  taken: Set<string>,
): { patch: Map<string, CanonicalElement | null>; groupId: string } | null {
  const raw = [...ids].filter(id => elements.get(id)?.tableName !== GROUP_TABLE);
  // Selecting a group selects its row too: regrouping a whole group nests nothing, it re-forms
  const members = [...expandCopySet(elements, raw)].map(id => elements.get(id)!).filter(isGroupable);
  if (members.length === 0) return null;
  const b = elementsBounds(members);
  if (!b) return null;
  const groupId = generateId(GROUP_TABLE, taken);
  taken.add(groupId);
  const patch = new Map<string, CanonicalElement | null>();
  patch.set(groupId, groupRow(groupId, name, boundsCenter(b)));
  for (const m of members) patch.set(m.id, { ...m, attrs: { ...m.attrs, group_id: groupId } });
  return { patch, groupId };
}

export function ungroupPatch(elements: ReadonlyMap<string, CanonicalElement>, groupId: string): Map<string, CanonicalElement | null> {
  const patch = new Map<string, CanonicalElement | null>();
  if (!elements.has(groupId)) return patch;
  patch.set(groupId, null);
  for (const id of groupMembers(elements, groupId)) {
    const el = elements.get(id)!;
    const attrs = { ...el.attrs };
    delete attrs.group_id;
    patch.set(id, { ...el, attrs });
  }
  return patch;
}

/**
 * Keep groups consistent after an edit (mutates `next`, records in before/after):
 * a row without members is deleted; a member whose row is gone leaves the group.
 */
export function cleanupGroups(
  next: Map<string, CanonicalElement>,
  prev: ReadonlyMap<string, CanonicalElement>,
  before: Map<string, CanonicalElement | null>,
  after: Map<string, CanonicalElement | null>,
): void {
  const rows = new Set<string>();
  const counts = new Map<string, number>();
  let any = false;
  for (const el of next.values()) {
    if (el.tableName === GROUP_TABLE) { rows.add(el.id); any = true; continue; }
    const g = el.attrs.group_id;
    if (g) { counts.set(g, (counts.get(g) ?? 0) + 1); any = true; }
  }
  if (!any) return;
  const record = (id: string, el: CanonicalElement | null) => {
    if (!before.has(id)) before.set(id, prev.get(id) ?? null);
    after.set(id, el);
    if (el) next.set(id, el); else next.delete(id);
  };
  for (const id of rows) if (!counts.has(id)) record(id, null);
  for (const el of [...next.values()]) {
    const g = el.attrs.group_id;
    if (g && !rows.has(g)) {
      const attrs = { ...el.attrs };
      delete attrs.group_id;
      record(el.id, { ...el, attrs });
    }
  }
}

/** Members of an instance plus the ports and doors riding on them. */
export function instanceElements(elements: ReadonlyMap<string, CanonicalElement>, groupId: string): Set<string> {
  const set = expandCopySet(elements, groupMembers(elements, groupId));
  for (const id of [...set]) {
    const el = elements.get(id)!;
    if (ANNOTATION_TABLES.has(el.tableName)) set.delete(id);
  }
  return set;
}

/** Key points of an element in a frame (for matching instance members). */
function keyPoints(el: CanonicalElement): Point[] {
  switch (el.geometry) {
    case 'line':
    case 'spatial_line': return [el.start, el.end];
    case 'point': return [el.position];
    case 'polygon': return el.vertices;
  }
}

const MATCH_TOL = 0.002;

function samePlace(a: CanonicalElement, b: CanonicalElement): boolean {
  if (a.tableName !== b.tableName || a.geometry !== b.geometry) return false;
  const pa = keyPoints(a), pb = keyPoints(b);
  if (pa.length !== pb.length) return false;
  const near = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y) <= MATCH_TOL;
  if (pa.every((p, i) => near(p, pb[i]))) return true;
  // Lines may run either way; polygons may start anywhere
  if (pa.length === 2) return near(pa[0], pb[1]) && near(pa[1], pb[0]);
  return pa.every(p => pb.some(q => near(p, q)));
}

/** Elements of `ids` in the instance's local frame. */
function localForm(elements: ReadonlyMap<string, CanonicalElement>, ids: Iterable<string>, T: Xform): Map<string, CanonicalElement> {
  return transformElements(elements, ids, invert(T));
}

export interface InstanceOnLevel {
  levelId: string;
  /** That level's elements. */
  elements: ReadonlyMap<string, CanonicalElement>;
  rowId: string;
  /** Ids already used on that level (new members get fresh ones). */
  taken: Set<string>;
}

/**
 * Rebuild instance `target` from the edited instance. `edited` = the edited
 * level's elements now; `snapshot` = the edited instance before editing
 * (row + members). Returns the patch for the target's level.
 */
export function propagateGroupEdit(
  edited: ReadonlyMap<string, CanonicalElement>,
  editedRowId: string,
  snapshot: ReadonlyMap<string, CanonicalElement>,
  target: InstanceOnLevel,
): Map<string, CanonicalElement | null> {
  const patch = new Map<string, CanonicalElement | null>();
  const row = edited.get(editedRowId);
  const row0 = snapshot.get(editedRowId);
  const targetRow = target.elements.get(target.rowId);
  if (!row || !row0 || !targetRow) return patch;

  const TA = groupTransform(row), TA0 = groupTransform(row0), TB = groupTransform(targetRow);
  // Before the edit both instances were the same group in local coordinates: match them up
  const snapIds = [...snapshot.keys()].filter(id => id !== editedRowId);
  const local0 = localForm(snapshot, snapIds, TA0);
  const bIds = [...instanceElements(target.elements, target.rowId)];
  const localB = localForm(target.elements, bIds, TB);
  const matchOf = new Map<string, string>();   // edited-instance id → target id
  const usedB = new Set<string>();
  for (const [aid, a] of local0) {
    if (a.tableName === 'connector') continue;
    for (const [bid, b] of localB) {
      if (usedB.has(bid) || b.tableName === 'connector') continue;
      if (samePlace(a, b)) { matchOf.set(aid, bid); usedB.add(bid); break; }
    }
  }
  // Ports: same name on the matched host
  for (const [aid, a] of snapshot) {
    if (a.tableName !== 'connector' || !a.hostId) continue;
    const hostB = matchOf.get(a.hostId);
    if (!hostB) continue;
    for (const bid of bIds) {
      const b = target.elements.get(bid)!;
      if (b.tableName === 'connector' && b.hostId === hostB && (b.attrs.name ?? '') === (a.attrs.name ?? '') && !usedB.has(bid)) {
        matchOf.set(aid, bid); usedB.add(bid); break;
      }
    }
  }

  // New content of the target: the edited instance mapped into the target's frame
  const nowIds = [...instanceElements(edited, editedRowId)];
  const taken = new Set(target.taken);
  for (const id of usedB) taken.delete(id);
  const preset = new Map<string, string>();
  for (const id of nowIds) { const m = matchOf.get(id); if (m) preset.set(id, m); }
  const { clones, idMap } = cloneElements(edited, nowIds, { taken, preset });
  const placed = transformElements(clones, clones.keys(), compose(TB, invert(TA)));
  for (const [src, id] of idMap) {
    const el = placed.get(id);
    if (el && edited.get(src)?.attrs.group_id === editedRowId) placed.set(id, { ...el, attrs: { ...el.attrs, group_id: target.rowId } });
  }
  for (const [id, el] of placed) patch.set(id, el);
  // Old members the edit removed
  const kept = new Set(placed.keys());
  const removed: string[] = [];
  for (const bid of bIds) if (!kept.has(bid)) { patch.set(bid, null); removed.push(bid); }
  // Their tags go too; dimensions on them become fixed
  if (removed.length) {
    const gone = new Set(removed);
    for (const el of target.elements.values()) {
      if (el.tableName === 'tag' && gone.has(el.attrs.host_id ?? '')) patch.set(el.id, null);
      if (el.tableName === 'dimension') {
        const attrs = { ...el.attrs };
        let touched = false;
        for (const side of ['start_ref', 'end_ref'] as const) {
          if (gone.has(parseRef(attrs[side]).id)) { attrs[side] = ''; touched = true; }
        }
        if (touched) patch.set(el.id, { ...el, attrs });
      }
    }
  }
  return patch;
}
