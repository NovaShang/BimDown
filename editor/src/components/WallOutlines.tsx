import React, { useMemo } from 'react';
import type { DocumentState } from '../model/document.ts';
import type { LineElement } from '../model/elements.ts';
import { computeCornerAdjustments, type WallSegment, type MiterResult } from '../utils/wallMiter.ts';

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
  document: doc,
  visibleLayers,
  activeDiscipline,
}: WallOutlinesProps) {
  const { lines, fills } = useMemo(() => {
    const wallSegs: { seg: WallSegment; table: string }[] = [];
    const mepSegs: { seg: WallSegment; table: string }[] = [];

    for (const el of doc.elements.values()) {
      if (el.geometry !== 'line') continue;
      const line = el as LineElement;
      const isWall = WALL_TABLES.has(el.tableName);
      const isMep = MEP_TABLES.has(el.tableName);
      if (!isWall && !isMep) continue;

      const layerKey = `${el.discipline}/${el.tableName}`;
      if (!visibleLayers.has(layerKey)) continue;
      if (el.discipline !== activeDiscipline && el.discipline !== 'architechture') continue;

      const material = (line.attrs.material ?? '').toLowerCase();
      let fill = 'none';
      if (isWall) {
        if (material.includes('concrete')) fill = '#d4d4d4';
        else if (material.includes('metal') || material.includes('steel')) fill = '#e8e8e8';
        else fill = '#f0f0f0';
      }

      const seg: WallSegment = {
        id: line.id,
        x1: line.start.x, y1: line.start.y,
        x2: line.end.x, y2: line.end.y,
        halfWidth: line.strokeWidth / 2,
        fill,
      };

      if (isWall) wallSegs.push({ seg, table: el.tableName });
      else mepSegs.push({ seg, table: el.tableName });
    }

    const wallMiter = computeCornerAdjustments(wallSegs.map(w => w.seg));
    const mepMiter = computeCornerAdjustments(mepSegs.map(m => m.seg));

    const outLines: { x1: number; y1: number; x2: number; y2: number; color: string; width: number }[] = [];
    const outFills: { points: string; fill: string }[] = [];

    const emitOutlines = (
      items: { seg: WallSegment; table: string }[],
      miter: MiterResult,
    ) => {
      const adj = miter.adjustments;

      // End-cap detection: count endpoints
      const endpointCount = new Map<string, number>();
      const pk = (x: number, y: number) => `${(Math.round(x / 0.002) * 0.002).toFixed(4)},${(Math.round(y / 0.002) * 0.002).toFixed(4)}`;
      for (const { seg } of items) {
        for (const k of [pk(seg.x1, seg.y1), pk(seg.x2, seg.y2)]) {
          endpointCount.set(k, (endpointCount.get(k) ?? 0) + 1);
        }
      }

      for (const { seg, table } of items) {
        const style = OUTLINE_STYLES[table] ?? { color: '#888', width: 0.02 };
        const dx = seg.x2 - seg.x1;
        const dy = seg.y2 - seg.y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) continue;
        const nx = -dy / len, ny = dx / len;
        const hw = seg.halfWidth;

        let p1 = { x: seg.x1 + nx * hw, y: seg.y1 + ny * hw };
        let p2 = { x: seg.x2 + nx * hw, y: seg.y2 + ny * hw };
        let p3 = { x: seg.x2 - nx * hw, y: seg.y2 - ny * hw };
        let p4 = { x: seg.x1 - nx * hw, y: seg.y1 - ny * hw };

        const startAdj = adj.get(`${seg.id}:start`);
        if (startAdj) { p1 = startAdj.left; p4 = startAdj.right; }
        const endAdj = adj.get(`${seg.id}:end`);
        if (endAdj) { p2 = endAdj.right; p3 = endAdj.left; }

        // Two side lines
        outLines.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, color: style.color, width: style.width });
        outLines.push({ x1: p4.x, y1: p4.y, x2: p3.x, y2: p3.y, color: style.color, width: style.width });

        // End caps at free endpoints
        if ((endpointCount.get(pk(seg.x1, seg.y1)) ?? 0) < 2) {
          outLines.push({ x1: p1.x, y1: p1.y, x2: p4.x, y2: p4.y, color: style.color, width: style.width });
        }
        if ((endpointCount.get(pk(seg.x2, seg.y2)) ?? 0) < 2) {
          outLines.push({ x1: p2.x, y1: p2.y, x2: p3.x, y2: p3.y, color: style.color, width: style.width });
        }
      }

      // Junction fills
      for (const jf of miter.junctionFills) {
        outFills.push({
          points: jf.points.map(p => `${p.x},${p.y}`).join(' '),
          fill: jf.fill,
        });
      }
    };

    emitOutlines(wallSegs, wallMiter);
    emitOutlines(mepSegs, mepMiter);

    return { lines: outLines, fills: outFills };
  }, [doc.elements, visibleLayers, activeDiscipline]);

  if (lines.length === 0 && fills.length === 0) return null;

  return (
    <g className="wall-outlines" transform="scale(1,-1)" style={{ pointerEvents: 'none' }}>
      {fills.map((f, i) => (
        <polygon key={`f${i}`} points={f.points} fill={f.fill} stroke="none" />
      ))}
      {lines.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
          stroke={s.color} strokeWidth={s.width} />
      ))}
    </g>
  );
});
