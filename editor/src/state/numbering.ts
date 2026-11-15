/**
 * Auto-numbering in the editor (model/autoNumber.ts): new elements get the
 * next mark of their category when placed, and the Renumber command
 * re-sequences a selection, a level or the whole project (one undo step).
 */
import type { EditorState } from './editorTypes.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { parseFloorLayers, parseLayer } from '../model/parse.ts';
import {
  assignNumbers, columnFootprintsOf, doorNumberPool, levelBase, nextSequenceNumber, prefixFor, numberingKey, NUMBERED_TABLES, planOrder, type NumberingConfig,
} from '../model/autoNumber.ts';
import { levelElements, type LevelPatches } from './levelEdits.ts';
import { unitsPerMetreOf } from '../utils/units.ts';
import { getProjectUnits } from '../utils/units.ts';
import { toElementId } from '../model/ids.ts';

type NumberingState = Pick<EditorState, 'project' | 'document' | 'currentLevel'>;

/** Numbered elements of every level other than `except` (and global/), for the marks in use. */
function numberedElsewhere(state: NumberingState, except: string): CanonicalElement[] {
  const out: CanonicalElement[] = [];
  for (const [levelId, floor] of state.project?.floors ?? []) {
    if (levelId === except) continue;
    out.push(...parseFloorLayers(floor.layers.filter(l => NUMBERED_TABLES.has(l.tableName))));
  }
  for (const gl of state.project?.globalLayers ?? []) if (NUMBERED_TABLES.has(gl.tableName)) out.push(...parseLayer(gl));
  return out;
}

/**
 * Newly placed elements with an empty `number` take the next mark of their
 * category (structural ones the mark of their type when one exists).
 * Elements are returned as given when nothing is numbered.
 */
export function autoNumberCreated<T extends CanonicalElement>(state: NumberingState, created: readonly T[]): T[] {
  const doc = state.document;
  if (!doc || !state.project) return [...created];
  const targets = created.filter(e => NUMBERED_TABLES.has(e.tableName) && !(e.attrs.number ?? '').trim());
  if (targets.length === 0) return [...created];
  const level = state.project.levels.find(l => l.id === doc.levelId);
  const live = [...doc.elements.values()];
  const numbers = assignNumbers(targets, [...live, ...numberedElsewhere(state, doc.levelId)], {
    config: state.project.metadata.numbering, types: state.project.types, level,
    upm: unitsPerMetreOf(getProjectUnits({ project: state.project })),
    columns: columnFootprintsOf([...live, ...created]),
  });
  return created.map(e => {
    const n = numbers.get(e.id);
    return n ? ({ ...e, attrs: { ...e.attrs, number: n } } as T) : e;
  });
}

/** A source of new door marks on the open level (D1xx after every door / curtain wall door in the project). */
export function doorNumberSource(state: NumberingState): () => string {
  const doc = state.document;
  const used = doorNumberPool([...(doc?.elements.values() ?? []), ...numberedElsewhere(state, doc?.levelId ?? ''), ...curtainWallsElsewhere(state, doc?.levelId ?? '')]);
  const level = state.project?.levels.find(l => l.id === doc?.levelId);
  const prefix = prefixFor('door', state.project?.metadata.numbering);
  return () => nextSequenceNumber(prefix, used, levelBase(level));
}

function curtainWallsElsewhere(state: NumberingState, except: string): CanonicalElement[] {
  const out: CanonicalElement[] = [];
  for (const [levelId, floor] of state.project?.floors ?? []) {
    if (levelId !== except) out.push(...parseFloorLayers(floor.layers.filter(l => l.tableName === 'curtain_wall')));
  }
  for (const gl of state.project?.globalLayers ?? []) if (gl.tableName === 'curtain_wall') out.push(...parseLayer(gl));
  return out;
}

export type RenumberScope = 'selection' | 'level' | 'project';

/** Numbering keys present in a scope, with their element counts. */
export function renumberCategories(state: EditorState, scope: RenumberScope): Map<string, number> {
  const out = new Map<string, number>();
  for (const [, els] of scopeElements(state, scope)) {
    const columns = columnFootprintsOf(els.all);
    for (const el of els.targets) {
      const k = numberingKey(el, columns);
      if (k) out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

function scopeElements(state: EditorState, scope: RenumberScope): Map<string, { all: CanonicalElement[]; targets: CanonicalElement[] }> {
  const out = new Map<string, { all: CanonicalElement[]; targets: CanonicalElement[] }>();
  const levels = scope === 'project' ? (state.project?.levels ?? []).map(l => l.id) : [state.currentLevel];
  const selected = new Set([...state.selectedIds].map(toElementId));
  for (const levelId of levels) {
    const all = [...levelElements(state, levelId).values()];
    const targets = all.filter(e => NUMBERED_TABLES.has(e.tableName) && (scope !== 'selection' || selected.has(e.id)));
    out.set(levelId, { all, targets });
  }
  return out;
}

/**
 * Renumber the elements of `keys` in a scope, bottom-up by level and in plan
 * order (rows from the bottom, left to right): per-level patches.
 */
export function renumberPatches(state: EditorState, scope: RenumberScope, keys: ReadonlySet<string>, config?: NumberingConfig): LevelPatches {
  const patches: LevelPatches = new Map();
  if (!state.project) return patches;
  const scoped = scopeElements(state, scope);
  const upm = unitsPerMetreOf(getProjectUnits(state));
  const levels = [...state.project.levels].sort((a, b) => a.elevation - b.elevation).filter(l => scoped.has(l.id));
  // Marks kept: everything numbered outside the renumbered set (other levels, other categories).
  const keyOf = new Map<CanonicalElement, string | null>();
  for (const [, s] of scoped) {
    const columns = columnFootprintsOf(s.all);
    for (const el of s.all) keyOf.set(el, numberingKey(el, columns));
  }
  const renumbered = new Set<string>();
  for (const [levelId, s] of scoped) for (const el of s.targets) if (keys.has(keyOf.get(el) ?? '')) renumbered.add(`${levelId}/${el.id}`);
  const kept: CanonicalElement[] = [];
  for (const [levelId, s] of scoped) for (const el of s.all) if (!renumbered.has(`${levelId}/${el.id}`)) kept.push(el);
  for (const lv of state.project.levels) if (!scoped.has(lv.id)) kept.push(...[...levelElements(state, lv.id).values()].filter(e => NUMBERED_TABLES.has(e.tableName)));
  for (const gl of state.project.globalLayers) if (NUMBERED_TABLES.has(gl.tableName)) kept.push(...parseLayer(gl));
  const assigned: CanonicalElement[] = [];
  for (const level of levels) {
    const s = scoped.get(level.id)!;
    const targets = s.targets.filter(e => renumbered.has(`${level.id}/${e.id}`)).sort(planOrder);
    if (targets.length === 0) continue;
    const numbers = assignNumbers(targets, [...kept, ...assigned], {
      config: config ?? state.project.metadata.numbering, types: state.project.types, level, upm, columns: columnFootprintsOf(s.all),
    });
    const patch = new Map<string, CanonicalElement | null>();
    for (const el of targets) {
      const n = numbers.get(el.id);
      if (!n) continue;
      const next = { ...el, attrs: { ...el.attrs, number: n } } as CanonicalElement;
      assigned.push(next);
      if (n !== (el.attrs.number ?? '')) patch.set(el.id, next);
    }
    if (patch.size > 0) patches.set(level.id, patch);
  }
  return patches;
}
