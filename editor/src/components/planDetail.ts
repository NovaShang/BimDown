/**
 * Plan drafting by zoom (Revit's detail level and line weights by view
 * scale): the canvas sets `data-detail` (coarse / medium / fine) and pen
 * widths (`--pen-*`, plan units) on the SVG root, from pixels per metre on
 * screen. They change only when the zoom crosses a bucket (a factor of 2), so
 * the restyle they cause is rare, not one per zoom step. Elements opt in with
 * the classes in editor.css (`pen-cut`, `pen-med`, `pen-thin`, `pen-hair`,
 * `plan-fine`, `plan-coarse`).
 */

export type PlanDetail = 'coarse' | 'medium' | 'fine';

/** Pixels per metre at which layered walls show their layers (≈ 1:50 on paper). */
export const FINE_PX_PER_M = 55;
/** Below this the plan is coarse (≈ 1:200 and smaller). */
export const MEDIUM_PX_PER_M = 18;

/** Screen widths (px) of the pens per detail level: cut outlines, door leaves / window frames, swings / glass, layer joints. */
const PENS_PX: Record<PlanDetail, { cut: number; med: number; thin: number; hair: number }> = {
  coarse: { cut: 1.1, med: 0.8, thin: 0.5, hair: 0.35 },
  medium: { cut: 1.6, med: 1.0, thin: 0.6, hair: 0.4 },
  fine:   { cut: 2.2, med: 1.3, thin: 0.75, hair: 0.5 },
};

export function planDetailFor(pxPerMetre: number): PlanDetail {
  return pxPerMetre >= FINE_PX_PER_M ? 'fine' : pxPerMetre >= MEDIUM_PX_PER_M ? 'medium' : 'coarse';
}

/** Pen widths in plan units for a zoom: the bucket's pixels per unit (power of 2). */
export function planPens(pxPerUnit: number, detail: PlanDetail): { cut: number; med: number; thin: number; hair: number; bucket: number } {
  const bucket = Math.pow(2, Math.round(Math.log2(Math.max(pxPerUnit, 1e-9))));
  const px = PENS_PX[detail];
  return { cut: px.cut / bucket, med: px.med / bucket, thin: px.thin / bucket, hair: px.hair / bucket, bucket };
}

const applied = new WeakMap<SVGSVGElement, string>();

/** Set detail level and pens on the plan's SVG root (no-op unless the bucket changed). */
export function applyPlanDetail(svg: SVGSVGElement, pxPerUnit: number, unitsPerMetre: number): void {
  const detail = planDetailFor(pxPerUnit * unitsPerMetre);
  const pens = planPens(pxPerUnit, detail);
  const key = `${detail}:${pens.bucket}`;
  if (applied.get(svg) === key) return;
  applied.set(svg, key);
  svg.dataset.detail = detail;
  const s = svg.style;
  s.setProperty('--pen-cut', `${pens.cut}`);
  s.setProperty('--pen-med', `${pens.med}`);
  s.setProperty('--pen-thin', `${pens.thin}`);
  s.setProperty('--pen-hair', `${pens.hair}`);
}
