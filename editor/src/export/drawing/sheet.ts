/** Sheet sizes, layout and scale selection for plan drawings (all in paper mm). */
import type { Box, PlanDrawing } from './types.ts';

export type PaperSize = 'A4' | 'A3' | 'A2';

/** ISO 216, landscape. */
export const PAPER_SIZES: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
};

/** Scales a user can pick; `auto` also tries the coarser ones. */
export const DRAWING_SCALES = [50, 100, 200] as const;
const AUTO_SCALES = [50, 100, 200, 500, 1000, 2000, 5000];

export interface Rect { x: number; y: number; w: number; h: number }

export interface SheetLayout {
  paper: { w: number; h: number };
  /** Drawing border. */
  frame: Rect;
  /** Title strip along the bottom of the frame. */
  titleBlock: Rect;
  /** Where the plan goes. */
  drawArea: Rect;
  /** Band under the plan for the view title and legend. */
  viewTitle: Rect;
  /** Text size factor relative to A3. */
  k: number;
}

export function sheetLayout(size: PaperSize): SheetLayout {
  const paper = PAPER_SIZES[size];
  const small = size === 'A4';
  // ISO 5457: 20 mm filing margin on the left, 10 mm elsewhere
  const left = small ? 15 : 20, other = small ? 8 : 10;
  const frame = { x: left, y: other, w: paper.w - left - other, h: paper.h - 2 * other };
  const k = Math.max(0.78, Math.min(1.2, frame.w / 390));
  const tbH = 22 * k;
  const titleBlock = { x: frame.x, y: frame.y + frame.h - tbH, w: frame.w, h: tbH };
  const pad = 5 * k;
  const vtH = 11 * k;
  const viewTitle = { x: frame.x + pad, y: titleBlock.y - pad - vtH, w: frame.w - 2 * pad, h: vtH };
  const drawArea = { x: frame.x + pad, y: frame.y + pad, w: frame.w - 2 * pad, h: viewTitle.y - frame.y - pad - 2 };
  return { paper, frame, titleBlock, drawArea, viewTitle, k };
}

/** Paper size of a drawing's extent at its own scale. */
export function paperExtent(bounds: Box | null, pm: number): { w: number; h: number } {
  if (!bounds) return { w: 0, h: 0 };
  return { w: (bounds.maxX - bounds.minX) / pm, h: (bounds.maxY - bounds.minY) / pm };
}

export function fits(d: PlanDrawing, area: Rect): boolean {
  const { w, h } = paperExtent(d.bounds, d.pm);
  return w <= area.w + 1e-6 && h <= area.h + 1e-6;
}

/**
 * Largest standard scale at which every drawing fits the sheet. `render`
 * builds the drawings at a scale (paper-sized text and bubbles change the
 * extent, so each candidate is rendered).
 */
export function pickScale(render: (scale: number) => PlanDrawing[], area: Rect): { scale: number; drawings: PlanDrawing[] } {
  let last: { scale: number; drawings: PlanDrawing[] } | null = null;
  for (const scale of AUTO_SCALES) {
    const drawings = render(scale);
    last = { scale, drawings };
    if (drawings.every(d => fits(d, area))) return last;
  }
  return last!;
}

/** Scale bar segment length in model display units (m or ft) giving ~`targetMm` for 4 segments. */
export function scaleBarStep(scale: number, metric: boolean, targetMm: number): { step: number; stepMm: number } {
  const steps = metric ? [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500] : [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const mmPer = metric ? 1000 / scale : 304.8 / scale; // paper mm per m / ft
  let best = steps[0];
  for (const s of steps) if (4 * s * mmPer <= targetMm) best = s;
  return { step: best, stepMm: best * mmPer };
}
