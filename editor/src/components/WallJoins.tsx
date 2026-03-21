import React, { useMemo } from 'react';
import type { DocumentState } from '../model/document.ts';
import type { LineElement } from '../model/elements.ts';
import { computeJunctionOverlays, type WallSegment } from '../utils/wallMiter.ts';

interface WallJoinsProps {
  document: DocumentState;
}

const WALL_TABLES = new Set(['wall', 'structure_wall']);
const MEP_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);

/**
 * Renders miter junction overlays on top of individually-rendered wall elements.
 * Covers junction gaps with fill polygons and draws correct miter outline segments.
 */
export const WallJoins = React.memo(function WallJoins({ document }: WallJoinsProps) {
  const overlays = useMemo(() => {
    const wallSegs: WallSegment[] = [];
    const mepSegs: WallSegment[] = [];

    for (const el of document.elements.values()) {
      if (el.geometry !== 'line') continue;
      const line = el as LineElement;
      const isWall = WALL_TABLES.has(el.tableName);
      const isMep = MEP_TABLES.has(el.tableName);
      if (!isWall && !isMep) continue;

      const seg: WallSegment = {
        id: line.id,
        x1: line.start.x, y1: line.start.y,
        x2: line.end.x, y2: line.end.y,
        halfWidth: line.strokeWidth / 2,
        fill: 'none',
      };

      if (isWall) {
        const material = line.attrs.material?.toLowerCase() || '';
        if (material.includes('concrete')) seg.fill = '#d4d4d4';
        else if (material.includes('metal') || material.includes('steel')) seg.fill = '#e8e8e8';
        wallSegs.push(seg);
      } else {
        if (el.tableName === 'duct') seg.fill = '#00b4d815';
        else if (el.tableName === 'pipe') seg.fill = '#06d6a015';
        else seg.fill = '#ffd16615';
        mepSegs.push(seg);
      }
    }

    const wallOverlays = computeJunctionOverlays(wallSegs, '#1a1a2e', 0.03);
    const mepOverlays = computeJunctionOverlays(mepSegs, '#00b4d8', 0.025);
    return [...wallOverlays, ...mepOverlays];
  }, [document.elements]);

  if (overlays.length === 0) return null;

  return (
    <g className="wall-joins" transform="scale(1,-1)">
      {overlays.map((o, i) => (
        <g key={i}>
          {/* Outer fill covers the gap and any crossing outlines underneath */}
          <polygon
            points={o.outerFill.map(v => `${v.x},${v.y}`).join(' ')}
            fill={o.fillColor}
            stroke="none"
          />
          {/* Inner fill covers inner crossing outlines */}
          <polygon
            points={o.innerFill.map(v => `${v.x},${v.y}`).join(' ')}
            fill={o.fillColor}
            stroke="none"
          />
          {/* Correct miter outline segments */}
          {o.outlines.map(([a, b], j) => (
            <line
              key={j}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={o.outlineColor}
              strokeWidth={o.outlineWidth}
            />
          ))}
        </g>
      ))}
    </g>
  );
});
