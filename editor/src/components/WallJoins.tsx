import React, { useMemo } from 'react';
import type { DocumentState } from '../model/document.ts';
import type { LineElement } from '../model/elements.ts';
import { computeWallJunctions, type WallSegment } from '../utils/wallJoins.ts';

interface WallJoinsProps {
  document: DocumentState;
}

const WALL_TABLES = new Set(['wall', 'structure_wall']);
const MEP_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);

/**
 * Renders fill-patch triangles at wall junction points to close corner gaps.
 * Placed below individual wall elements so wall outlines draw on top.
 */
export const WallJoins = React.memo(function WallJoins({ document }: WallJoinsProps) {
  const patches = useMemo(() => {
    const segments: WallSegment[] = [];
    for (const el of document.elements.values()) {
      if (el.geometry !== 'line') continue;
      const line = el as LineElement;
      const isWall = WALL_TABLES.has(el.tableName);
      const isMep = MEP_TABLES.has(el.tableName);
      if (!isWall && !isMep) continue;

      let fill = 'none';
      if (isWall) {
        const material = line.attrs.material?.toLowerCase() || '';
        if (material.includes('concrete')) fill = '#d4d4d4';
        else if (material.includes('metal') || material.includes('steel')) fill = '#e8e8e8';
      } else {
        // MEP lines use their discipline color with low opacity
        if (el.tableName === 'duct') fill = '#00b4d815';
        else if (el.tableName === 'pipe') fill = '#06d6a015';
        else fill = '#ffd16615';
      }
      segments.push({
        id: line.id,
        x1: line.start.x,
        y1: line.start.y,
        x2: line.end.x,
        y2: line.end.y,
        halfWidth: line.strokeWidth / 2,
        fill,
      });
    }
    return computeWallJunctions(segments);
  }, [document.elements]);

  if (patches.length === 0) return null;

  return (
    <g className="wall-joins" transform="scale(1,-1)">
      {patches.map((p, i) => (
        <polygon
          key={i}
          points={p.points.map(v => `${v.x},${v.y}`).join(' ')}
          fill={p.fill}
          stroke="none"
        />
      ))}
    </g>
  );
});
