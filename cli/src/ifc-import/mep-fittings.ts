/**
 * Kind of a passive fitting (mep_node.fitting): IFC PredefinedType, else the
 * Revit family / type name (English / German), else its legs: one leg on a
 * single-port fitting = cap, two = elbow / coupling / reducer / transition,
 * three = tee, four = cross. Tables are data: extend them for new vocabularies.
 */
import type { ImportContext, OutEl } from './context.js';
import { enumValue, str } from './model.js';
import { type V3, dot3 } from './math.js';

export type FittingKind = 'elbow' | 'tee' | 'tap' | 'cross' | 'reducer' | 'transition' | 'coupling' | 'cap';

export interface Leg { p: V3; dir: V3; el: OutEl }

/** IfcDuctFitting / IfcPipeFitting / IfcCableCarrierFitting predefined types. */
const PREDEFINED: Record<string, FittingKind | 'junction' | 'change'> = {
  BEND: 'elbow', CONNECTOR: 'coupling', JUNCTION: 'junction', TRANSITION: 'change', CROSS: 'cross', TEE: 'tee', REDUCER: 'reducer',
};

// First match wins.
export const FITTING_NAMES: [RegExp, FittingKind | 'change'][] = [
  [/\btap\b|take.?off|\bspud\b|\bshoe\b|spin.?in|abgriff|stutzen|anbohr|sattel/i, 'tap'],
  [/cross|kreuz|四通/i, 'cross'],
  [/\btee\b|t-st(ü|ue)ck|\bwye\b|y-branch|hosenst|abzweig|junction|三通/i, 'tee'],
  [/elbow|\bbend\b|bogen|winkel|\bknie|弯头/i, 'elbow'],
  [/transition|(ü|ue)bergang|reduc|reduz|taper|变径|异径/i, 'change'],
  [/\bcap\b|end.?cap|kappe|endst(ü|ue)ck|\bplug\b|blind|verschluss|deckel|堵头|管帽/i, 'cap'],
  [/coupling|\bunion\b|muffe|coupler|nipple|verbinder|直通|管箍/i, 'coupling'],
];

function sameShape(a: OutEl, b: OutEl): boolean {
  return (a.attrs.shape ?? '') === (b.attrs.shape ?? '');
}

function sameSize(a: OutEl, b: OutEl): boolean {
  const n = (v: unknown) => Number(v) || 0;
  return Math.abs(n(a.attrs.size_x) - n(b.attrs.size_x)) < 0.001 && Math.abs(n(a.attrs.size_y) - n(b.attrs.size_y)) < 0.001;
}

/** reducer (same shape) or transition (shape changes), from two legs when known. */
function change(legs: Leg[]): FittingKind {
  return legs.length === 2 && sameShape(legs[0].el, legs[1].el) ? 'reducer' : 'transition';
}

export function fittingKind(ctx: ImportContext, el: OutEl, added: 'coupling' | 'tap' | undefined, portCount: number, legs: Leg[]): FittingKind | null {
  if (added === 'tap') return 'tap';
  const n = legs.length;
  const geometric = (): FittingKind | null => {
    if (n === 1) return portCount === 1 ? 'cap' : null;
    if (n === 2) {
      if (dot3(legs[0].dir, legs[1].dir) >= -0.985) return 'elbow';
      if (!sameShape(legs[0].el, legs[1].el)) return 'transition';
      return sameSize(legs[0].el, legs[1].el) ? 'coupling' : 'reducer';
    }
    if (n === 3) return 'tee';
    if (n === 4) return 'cross';
    return null;
  };
  if (added || !el.src) return geometric();
  const { model } = ctx;
  // Our own exports say what it was
  const own = model.prop(el.src, /^BimDown$/, 'Fitting');
  if (typeof own === 'string' && own in LEGS) return own as FittingKind;
  const t = model.typeOf.get(el.src);
  const pt = enumValue(model.line(el.src)?.PredefinedType) ?? (t ? enumValue(model.line(t)?.PredefinedType) : null) ?? '';
  const named = PREDEFINED[pt]
    ?? FITTING_NAMES.find(([re]) => re.test(`${ctx.label(el.src) ?? ''} ${str(model.line(el.src)?.ObjectType) ?? ''} ${t ? str(model.line(t)?.Name) ?? '' : ''}`))?.[1];
  if (!named) return geometric();
  if (named === 'junction') return n >= 4 ? 'cross' : 'tee';
  if (named === 'change') return change(legs);
  // A name that promises fewer legs than the fitting has loses to the geometry
  if (n > LEGS[named] && named !== 'tap') return geometric();
  return named;
}

const LEGS: Record<FittingKind, number> = { cap: 1, tap: 1, elbow: 2, coupling: 2, reducer: 2, transition: 2, tee: 3, cross: 4 };
