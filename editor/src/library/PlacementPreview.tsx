/** Placement ghost for library components (DrawingOverlay, model Y-up group). */
import type { ReactNode } from 'react';
import type { Point } from '../model/elements.ts';
import { furniturePlan, resolveFurniture } from './furnitureLibrary.generated.ts';
import { renderPrims } from './FurnitureSymbol.tsx';

/** Ghost of the component under the cursor (DrawingOverlay, model Y-up group). */
export function FurniturePlacementPreview({ cursor, rotation, attrs, scale }: {
  cursor: Point; rotation?: number; attrs: Record<string, string>; scale: number;
}): ReactNode {
  const r = resolveFurniture(attrs);
  const rot = rotation ?? (parseFloat(attrs.rotation || '0') || 0);
  const { w, d } = r.params;
  const tick = 0.25;
  return (
    <g className="drawing-overlay" transform="scale(1,-1)">
      <g transform={`translate(${cursor.x},${cursor.y}) rotate(${rot})`} opacity={0.85}>
        <rect x={-w / 2} y={-d / 2} width={w} height={d} fill="#4fc3f7" fillOpacity={0.12}
          stroke="#4fc3f7" strokeWidth={0.06 / scale} strokeDasharray={`${0.4 / scale},${0.3 / scale}`} />
        {renderPrims(furniturePlan(r), { stroke: '#0284c7', width: 0.07 / scale, paper: 'rgba(255,255,255,0.6)' })}
        {/* Back marker: the edge that goes against the wall. */}
        <line x1={-w / 2} y1={d / 2} x2={w / 2} y2={d / 2} stroke="#0284c7" strokeWidth={0.22 / scale} />
        <line x1={0} y1={-d / 2} x2={0} y2={-d / 2 - tick} stroke="#0284c7" strokeWidth={0.1 / scale} />
      </g>
    </g>
  );
}
