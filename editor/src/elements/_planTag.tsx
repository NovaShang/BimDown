/**
 * Plan tag: an element mark (KZ1, KL3, F2…) drawn as text in model units,
 * shown when the "element numbers" view option is on. draw2D output sits in
 * the Y-up model frame, so the text is counter-flipped to read upright.
 */
import type { ReactNode } from 'react';

/** Text height of a plan tag, metres. */
export const PLAN_TAG_SIZE = 0.28;

export function PlanTag({ x, y, text, color = '#5d4037', size = PLAN_TAG_SIZE, angleDeg = 0 }: {
  x: number;
  y: number;
  text: string;
  color?: string;
  size?: number;
  /** Text direction in the Y-up frame, degrees CCW (e.g. along a beam). */
  angleDeg?: number;
}): ReactNode {
  if (!text) return null;
  // Keep text left-to-right: flip directions pointing "backwards".
  let a = ((angleDeg % 360) + 360) % 360;
  if (a > 90 && a <= 270) a -= 180;
  return (
    <g transform={`translate(${x},${y}) scale(1,-1) rotate(${-a})`} pointerEvents="none">
      <text x={0} y={0} textAnchor="middle" dominantBaseline="central"
        fontSize={size} fontFamily="Inter, sans-serif" fontWeight="600"
        fill={color} stroke="#ffffff" strokeWidth={size * 0.25} paintOrder="stroke"
        style={{ userSelect: 'none' }}>
        {text}
      </text>
    </g>
  );
}

/** Mark shown for an element: its `number`, else nothing. */
export function tagText(attrs: Record<string, string>): string {
  return (attrs.number ?? '').trim();
}
