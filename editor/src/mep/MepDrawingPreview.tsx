/** SVG previews for MEP placements (terminal array rectangle and its grid). */
import type { ReactNode } from 'react';
import { arrayLayout, SPACING_KEY } from './arrayTool.ts';

type P = { x: number; y: number };

export function mepDrawingPreview(opts: {
  activeTool: string;
  tableName: string | null;
  points: P[];
  cursor: P | null;
  drawingAttrs: Record<string, string>;
  scale: number;
}): ReactNode {
  const { activeTool, tableName, points, cursor, drawingAttrs, scale } = opts;
  if (activeTool !== 'draw_point' || tableName !== 'terminal' || points.length !== 1 || !cursor) return null;
  const a = points[0];
  const layout = arrayLayout(a.x, a.y, cursor.x, cursor.y, parseFloat(drawingAttrs[SPACING_KEY] || '3') || 3);
  const x0 = Math.min(a.x, cursor.x), y0 = Math.min(a.y, cursor.y);
  const w = Math.abs(cursor.x - a.x), h = Math.abs(cursor.y - a.y);
  return (
    <g className="drawing-overlay" transform="scale(1,-1)">
      <rect x={x0} y={y0} width={w} height={h} fill="#4fc3f7" fillOpacity={0.08} stroke="#4fc3f7" strokeWidth={0.06 / scale} strokeDasharray={`${0.4 / scale},${0.2 / scale}`} />
      {layout.ys.flatMap(y => layout.xs.map(x => (
        <circle key={`${x},${y}`} cx={x} cy={y} r={Math.max(0.08, 0.15 / scale)} fill="#4fc3f7" opacity={0.8} />
      )))}
    </g>
  );
}
