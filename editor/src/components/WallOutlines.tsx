import React, { useMemo } from 'react';
import type { DocumentState } from '../model/document.ts';
import type { LineElement } from '../model/elements.ts';
import { computeCornerAdjustments, type WallSegment } from '../utils/wallMiter.ts';

interface WallOutlinesProps {
  document: DocumentState;
  visibleLayers: Set<string>;
  activeDiscipline: string | null;
}

const WALL_TABLES = new Set(['wall', 'structure_wall']);
const MEP_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);

const OUTLINE_STYLES: Record<string, { color: string; width: number }> = {
  wall: { color: '#1a1a2e', width: 0.03 },
  structure_wall: { color: '#1a1a2e', width: 0.03 },
  duct: { color: '#00b4d8', width: 0.025 },
  pipe: { color: '#06d6a0', width: 0.02 },
  conduit: { color: '#ffd166', width: 0.015 },
  cable_tray: { color: '#ffd166', width: 0.02 },
};

/**
 * Unified wall/MEP outline layer. Replaces per-element outlines + WallJoins.
 * Computes miter-joined outlines for all visible wall-type elements as a batch,
 * so junctions are always correct and visibility changes are respected.
 */
export const WallOutlines = React.memo(function WallOutlines({
  document,
  visibleLayers,
  activeDiscipline,
}: WallOutlinesProps) {
  const segments = useMemo(() => {
    // Collect visible wall and MEP segments, grouped by outline style
    const wallSegs: { seg: WallSegment; table: string }[] = [];
    const mepSegs: { seg: WallSegment; table: string }[] = [];

    for (const el of document.elements.values()) {
      if (el.geometry !== 'line') continue;
      const line = el as LineElement;
      const isWall = WALL_TABLES.has(el.tableName);
      const isMep = MEP_TABLES.has(el.tableName);
      if (!isWall && !isMep) continue;

      // Check visibility
      const layerKey = `${el.discipline}/${el.tableName}`;
      if (!visibleLayers.has(layerKey)) continue;
      if (el.discipline !== activeDiscipline && el.discipline !== 'architechture') continue;

      const seg: WallSegment = {
        id: line.id,
        x1: line.start.x, y1: line.start.y,
        x2: line.end.x, y2: line.end.y,
        halfWidth: line.strokeWidth / 2,
        fill: 'none',
      };

      if (isWall) wallSegs.push({ seg, table: el.tableName });
      else mepSegs.push({ seg, table: el.tableName });
    }

    // Compute miter adjustments separately for walls and MEP
    const wallAdj = computeCornerAdjustments(wallSegs.map(w => w.seg));
    const mepAdj = computeCornerAdjustments(mepSegs.map(m => m.seg));

    // Build outline segments
    const lines: { x1: number; y1: number; x2: number; y2: number; color: string; width: number }[] = [];

    const emitOutlines = (
      items: { seg: WallSegment; table: string }[],
      adj: Map<string, { left: { x: number; y: number }; right: { x: number; y: number } }>,
    ) => {
      // Build junction set for end-cap detection
      const junctionEndpoints = new Set<string>();
      const ptKey = (x: number, y: number) => `${x.toFixed(4)},${y.toFixed(4)}`;
      const endpointCount = new Map<string, number>();
      for (const { seg } of items) {
        for (const k of [ptKey(seg.x1, seg.y1), ptKey(seg.x2, seg.y2)]) {
          endpointCount.set(k, (endpointCount.get(k) ?? 0) + 1);
        }
      }
      for (const [k, count] of endpointCount) {
        if (count >= 2) junctionEndpoints.add(k);
      }

      for (const { seg, table } of items) {
        const style = OUTLINE_STYLES[table] ?? { color: '#888', width: 0.02 };
        const dx = seg.x2 - seg.x1;
        const dy = seg.y2 - seg.y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) continue;
        const nx = -dy / len;
        const ny = dx / len;
        const hw = seg.halfWidth;

        // Default perpendicular corners
        let p1 = { x: seg.x1 + nx * hw, y: seg.y1 + ny * hw };
        let p2 = { x: seg.x2 + nx * hw, y: seg.y2 + ny * hw };
        let p3 = { x: seg.x2 - nx * hw, y: seg.y2 - ny * hw };
        let p4 = { x: seg.x1 - nx * hw, y: seg.y1 - ny * hw };

        // Apply miter adjustments
        const startAdj = adj.get(`${seg.id}:start`);
        if (startAdj) {
          p1 = startAdj.left;
          p4 = startAdj.right;
        }
        const endAdj = adj.get(`${seg.id}:end`);
        if (endAdj) {
          p2 = endAdj.right;
          p3 = endAdj.left;
        }

        // Side 1: p1 → p2
        lines.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, color: style.color, width: style.width });
        // Side 2: p4 → p3
        lines.push({ x1: p4.x, y1: p4.y, x2: p3.x, y2: p3.y, color: style.color, width: style.width });

        // End caps where wall doesn't connect to another
        const startKey = ptKey(seg.x1, seg.y1);
        if (!junctionEndpoints.has(startKey)) {
          lines.push({ x1: p1.x, y1: p1.y, x2: p4.x, y2: p4.y, color: style.color, width: style.width });
        }
        const endKey = ptKey(seg.x2, seg.y2);
        if (!junctionEndpoints.has(endKey)) {
          lines.push({ x1: p2.x, y1: p2.y, x2: p3.x, y2: p3.y, color: style.color, width: style.width });
        }
      }
    };

    emitOutlines(wallSegs, wallAdj);
    emitOutlines(mepSegs, mepAdj);

    return lines;
  }, [document.elements, visibleLayers, activeDiscipline]);

  if (segments.length === 0) return null;

  return (
    <g className="wall-outlines" transform="scale(1,-1)" style={{ pointerEvents: 'none' }}>
      {segments.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
          stroke={s.color} strokeWidth={s.width} />
      ))}
    </g>
  );
});
