/**
 * Associativity pass for annotations, run after every editor action
 * (wraps the reducer, see EditorContext). Keeps the stored CSV columns of
 * dimensions / tags / text notes in step with the model:
 *
 *  - a committed edit that moves an element a dimension references re-resolves
 *    that end and stores the new point; deleting the target turns the end into
 *    a fixed point (no dangling reference is ever written);
 *  - dragging a referenced dimension moves its line (offset), not its ends;
 *  - pinned tags follow their host by the host's displacement; tags of a
 *    deleted host are deleted;
 *  - an unpinned tag that the user drags becomes pinned where it was dropped;
 *  - geometry ↔ x/y/start_x… columns stay in sync both ways.
 *
 * The patches are merged into the history command the action just pushed, so
 * undo/redo restore annotations together with the model. Unpinned tags also
 * get their resolved spot (`position` = `tagBase`) refreshed on every
 * non-preview change — derived state, kept out of history.
 */
import type { EditorState, EditorAction } from '../state/editorTypes.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { isAnnotationTable, isTagPinned, syncAnnotationAttrs, fmtCoord, type TagElement } from './model.ts';
import { parseRef, resolveDimension, resolveRefPoint, tagDefaultPosition, sub, add, len, dot, type Lookup } from './geometry.ts';

const EPS = 1e-6;
const near = (a: Point, b: Point) => len(sub(a, b)) < EPS;

function isPreview(action: EditorAction): boolean {
  return (action.type === 'MOVE_ELEMENTS' || action.type === 'RESIZE_ELEMENT') && !!action.preview;
}

/** Patches for one committed command. `elements` is the post-command document. */
export function annotationPatches(
  elements: Map<string, CanonicalElement>,
  before: Map<string, CanonicalElement | null>,
  after: Map<string, CanonicalElement | null>,
  prevElements: Map<string, CanonicalElement>,
): Map<string, CanonicalElement | null> {
  const patches = new Map<string, CanonicalElement | null>();
  const changed = new Set<string>([...before.keys(), ...after.keys()]);
  // Nothing but annotations touched and none of them moved → cheap exit
  const lookup: Lookup = id => elements.get(id);
  const lookupBefore: Lookup = id => (before.has(id) ? before.get(id) ?? undefined : prevElements.get(id));
  const deleted = (id: string) => changed.has(id) && !elements.has(id);

  for (const el of elements.values()) {
    if (!isAnnotationTable(el.tableName)) continue;
    const self = changed.has(el.id);
    const prior = before.get(el.id) ?? null;
    let cur: CanonicalElement = el;

    if (el.tableName === 'dimension' && cur.geometry === 'line') {
      const refs = [cur.attrs.start_ref ?? '', cur.attrs.end_ref ?? ''];
      const hasRef = refs.some(r => !!parseRef(r).id);
      // Columns edited in the panel → geometry follows
      if (self && prior?.geometry === 'line' && near(prior.start, cur.start) && near(prior.end, cur.end)) {
        const sx = parseFloat(cur.attrs.start_x), sy = parseFloat(cur.attrs.start_y);
        const ex = parseFloat(cur.attrs.end_x), ey = parseFloat(cur.attrs.end_y);
        if ([sx, sy, ex, ey].every(Number.isFinite)) cur = { ...cur, start: { x: sx, y: sy }, end: { x: ex, y: ey } };
      }
      // A dragged referenced dimension: keep its ends, move its line
      if (self && hasRef && prior?.geometry === 'line' && cur.geometry === 'line') {
        const d1 = sub(cur.start, prior.start), d2 = sub(cur.end, prior.end);
        if (len(d1) > EPS && near(d1, d2)) {
          const old = resolveDimension(prior, lookupBefore);
          const restored = { ...cur, start: prior.start, end: prior.end };
          const now = resolveDimension(restored, lookup);
          if (old && now) {
            const offset = (parseFloat(cur.attrs.offset) || 0) + dot(d1, old.n) - dot(sub(now.p1, old.p1), old.n);
            cur = { ...restored, attrs: { ...restored.attrs, offset: fmtCoord(offset) } };
          }
        }
      }
      // Re-resolve ends whose target changed; drop references to deleted elements
      if (cur.geometry === 'line') {
        let start = cur.start, end = cur.end;
        const attrs = { ...cur.attrs };
        let touched = false;
        (['start', 'end'] as const).forEach((side, i) => {
          const { id } = parseRef(refs[i]);
          if (!id || !(changed.has(id) || self)) return;
          if (deleted(id)) { attrs[`${side}_ref`] = ''; touched = true; return; }
          const stored = side === 'start' ? start : end;
          const p = resolveRefPoint(refs[i], stored, lookup);
          if (!near(p, stored)) {
            if (side === 'start') start = p; else end = p;
            touched = true;
          }
        });
        if (touched) cur = { ...cur, start, end, attrs };
      }
    } else if (el.tableName === 'text_note' && cur.geometry === 'point' && self && prior?.geometry === 'point') {
      if (near(prior.position, cur.position)) {
        const x = parseFloat(cur.attrs.x), y = parseFloat(cur.attrs.y);
        if (Number.isFinite(x) && Number.isFinite(y)) cur = { ...cur, position: { x, y } };
      }
    } else if (el.tableName === 'tag' && cur.geometry === 'point') {
      const hostId = cur.attrs.host_id ?? '';
      const host = elements.get(hostId);
      if (!host) {
        if (deleted(hostId)) patches.set(el.id, null);
        continue;
      }
      const hostMoved = changed.has(hostId);
      const priorHost = hostMoved ? lookupBefore(hostId) : undefined;
      const hostDelta = priorHost ? sub(tagDefaultPosition(host, lookup), tagDefaultPosition(priorHost, lookupBefore)) : { x: 0, y: 0 };
      if (isTagPinned(cur)) {
        if (self && prior?.geometry === 'point' && near(prior.position, cur.position)) {
          // x/y typed in the panel
          const x = parseFloat(cur.attrs.x), y = parseFloat(cur.attrs.y);
          if (Number.isFinite(x) && Number.isFinite(y)) cur = { ...cur, position: { x, y } };
        } else if (!self && hostMoved && len(hostDelta) > EPS) {
          cur = { ...cur, position: add(cur.position, hostDelta) };
        }
      } else if (self && prior) {
        const base = (cur as TagElement).tagBase ?? cur.position;
        const moved = sub(cur.position, base);
        // Moved together with its host by the same amount → still follows it
        if (len(moved) > EPS && !near(moved, hostDelta)) {
          const pinned: TagElement = { ...cur, attrs: { ...cur.attrs, x: fmtCoord(cur.position.x), y: fmtCoord(cur.position.y) } };
          delete pinned.tagBase;
          cur = pinned;
        }
      }
    }

    cur = syncAnnotationAttrs(cur);
    if (cur !== el) patches.set(el.id, cur);
  }
  return patches;
}

/** Point unpinned tags at their host's current default spot (no history). */
function refreshTagBases(elements: Map<string, CanonicalElement>): Map<string, CanonicalElement> | null {
  let next: Map<string, CanonicalElement> | null = null;
  const lookup: Lookup = id => elements.get(id);
  for (const el of elements.values()) {
    if (el.tableName !== 'tag' || el.geometry !== 'point' || isTagPinned(el)) continue;
    const host = elements.get(el.attrs.host_id ?? '');
    if (!host) continue;
    const def = tagDefaultPosition(host, lookup);
    const base = (el as TagElement).tagBase;
    if (base && near(base, def) && near(el.position, def)) continue;
    next ??= new Map(elements);
    next.set(el.id, { ...el, position: def, tagBase: def } as TagElement);
  }
  return next;
}

export function syncAnnotations(prev: EditorState, next: EditorState, action: EditorAction): EditorState {
  const doc = next.document;
  if (!doc || doc === prev.document || isPreview(action)) return next;

  let elements = doc.elements;
  let result = next;
  const top = next.history.undoStack[next.history.undoStack.length - 1];
  const prevTop = prev.history.undoStack[prev.history.undoStack.length - 1];
  const pushed = top && top !== prevTop && action.type !== 'UNDO' && action.type !== 'REDO';

  if (pushed && prev.document) {
    const patches = annotationPatches(elements, top.before, top.after, prev.document.elements);
    if (patches.size > 0) {
      elements = new Map(elements);
      const cmdBefore = new Map(top.before);
      const cmdAfter = new Map(top.after);
      const keys = new Set(next.lastMutation?.keys ?? []);
      for (const [id, el] of patches) {
        const old = elements.get(id) ?? null;
        if (!cmdBefore.has(id)) cmdBefore.set(id, prev.document.elements.get(id) ?? old);
        cmdAfter.set(id, el);
        if (el) elements.set(id, el); else elements.delete(id);
        const ref = el ?? old;
        if (ref) keys.add(`${ref.discipline}/${ref.tableName}`);
      }
      const undoStack = [...next.history.undoStack.slice(0, -1), { ...top, before: cmdBefore, after: cmdAfter }];
      result = {
        ...result,
        history: { ...next.history, undoStack },
        lastMutation: next.lastMutation ? { ...next.lastMutation, keys: [...keys] } : next.lastMutation,
      };
    }
  }

  const refreshed = refreshTagBases(elements);
  if (refreshed) elements = refreshed;
  if (elements === doc.elements) return result;
  return { ...result, document: { ...doc, elements } };
}
