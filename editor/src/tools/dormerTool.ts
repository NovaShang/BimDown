/**
 * Dormer placement (roof toolbar variant `dormer`, driven by the pick tool):
 * hover a sloped roof plane to preview, click to place the dormer's front
 * centre there. Creates the roof opening, dormer roof and walls as one undo
 * step (geometry/dormer.ts, model/dormerElements.ts).
 */
import type { ToolContext, ToolStateSnapshot } from './types.ts';
import type { CanonicalElement, PolygonElement, Point } from '../model/elements.ts';
import { roofSolution } from '../geometry/attach.ts';
import { pointInPolygon, signedArea } from '../geometry/roofSolver.ts';
import { DORMER_DEFAULTS, layoutDormer, type DormerKind, type DormerLayout } from '../geometry/dormer.ts';
import { dormerElements } from '../model/dormerElements.ts';
import { showNotice } from '../state/modifyUi.ts';

export const DORMER_VARIANT = 'dormer';
export const DORMER_KIND_KEY = '__dormer_kind';
export const DORMER_WIDTH_KEY = '__dormer_width';
export const DORMER_FRONT_KEY = '__dormer_front';
export const DORMER_OVERHANG_KEY = '__overhang';

const num = (s: string | undefined, fallback: number) => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : fallback;
};

export function isDormerTarget(state: Pick<ToolStateSnapshot, 'drawingTarget'>): boolean {
  return state.drawingTarget?.tableName === 'roof' && state.drawingTarget.variantId === DORMER_VARIANT;
}

/** The roof under `p` (the smallest containing it) and the dormer it would get. */
export function dormerAt(state: ToolStateSnapshot, p: Point): { host: PolygonElement; layout: DormerLayout } | { error: string } | null {
  const roofs: PolygonElement[] = [];
  for (const el of state.document?.elements.values() ?? []) {
    if (el.tableName === 'roof' && el.geometry === 'polygon' && el.vertices.length >= 3 && pointInPolygon(p, el.vertices)) roofs.push(el);
  }
  if (roofs.length === 0) return null;
  roofs.sort((a, b) => Math.abs(signedArea(a.vertices)) - Math.abs(signedArea(b.vertices)));
  const da = state.drawingAttrs;
  const opts = {
    kind: (da[DORMER_KIND_KEY] === 'shed' ? 'shed' : 'gable') as DormerKind,
    width: Math.max(0.6, num(da[DORMER_WIDTH_KEY], DORMER_DEFAULTS.width)),
    frontHeight: Math.max(0.3, num(da[DORMER_FRONT_KEY], DORMER_DEFAULTS.frontHeight)),
    slope: Math.min(60, Math.max(1, num(da.slope, DORMER_DEFAULTS.slope))),
    overhang: Math.max(0, num(da[DORMER_OVERHANG_KEY], DORMER_DEFAULTS.overhang)),
  };
  let error = 'outside';
  for (const host of roofs) {
    const layout = layoutDormer({
      vertices: host.vertices, baseOffset: num(host.attrs.base_offset, 0),
      thickness: num(host.attrs.thickness, 0.2) || 0.2, solution: roofSolution(host),
    }, p, opts);
    if (typeof layout !== 'string') return { host, layout };
    error = layout;
  }
  return { error };
}

export function buildDormer(state: ToolStateSnapshot, host: PolygonElement, layout: DormerLayout): CanonicalElement[] {
  const da = state.drawingAttrs;
  return dormerElements({
    layout,
    hostRoofId: host.id,
    levelId: state.document?.levelId ?? state.currentLevel,
    existingIds: state.document?.elements.keys() ?? [],
    wallThickness: 0.15,
    roofThickness: num(da.thickness, num(host.attrs.thickness, 0.2)) || 0.2,
    material: da.material || host.attrs.material || 'wood',
    wallMaterial: 'wood',
  });
}

/** Pick-tool hover: preview the dormer roof outline. */
export function dormerHover(ctx: ToolContext, p: Point) {
  const r = dormerAt(ctx.getState(), p);
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: r && 'layout' in r ? r.layout.roof : [], cursor: p } });
}

/** Pick-tool click: place the dormer (one undo step). */
export function dormerClick(ctx: ToolContext, p: Point) {
  const state = ctx.getState();
  const r = dormerAt(state, p);
  if (!r) { showNotice('notice.dormerNoRoof'); return; }
  if (!('layout' in r)) {
    showNotice(r.error === 'shallow' ? 'notice.dormerShallow' : r.error === 'tall' ? 'notice.dormerTall' : 'notice.dormerFlat');
    return;
  }
  const elements = buildDormer(state, r.host, r.layout);
  ctx.dispatch({ type: 'CREATE_ELEMENTS', elements, description: 'Place dormer' });
  ctx.dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: p } });
}
