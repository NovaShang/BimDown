import React, { useMemo } from 'react';
import type { DocumentState } from '../model/document.ts';
import type { LineElement } from '../model/elements.ts';
import {
  computeCornerAdjustments,
  computeOuterEdges,
  ptKey,
  type WallSegment,
  type WallPolygon,
} from '../utils/wallMiter.ts';

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
 * Unified wall/MEP outline layer.
 * Computes per-wall polygons (with miter + T-junction adjustments),
 * then clips edges against all other polygons to produce only the
 * outer boundary of the union — like architectural drawings.
 */
export const WallOutlines = React.memo(function WallOutlines({
  document: doc,
  visibleLayers,
  activeDiscipline,
}: WallOutlinesProps) {
  const data = useMemo(() => {
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

    const processGroup = (items: { seg: WallSegment; table: string }[]) => {
      if (items.length === 0) return { edges: [] as [{ x: number; y: number }, { x: number; y: number }][], fills: [] as { points: string; fill: string }[], color: '#888', width: 0.02 };

      const segs = items.map(i => i.seg);
      const miter = computeCornerAdjustments(segs);
      const adj = miter.adjustments;
      const style = OUTLINE_STYLES[items[0].table] ?? { color: '#888', width: 0.02 };

      // Build per-wall polygons
      const polygons: WallPolygon[] = [];
      for (const { seg } of items) {
        const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) continue;
        const nx = -dy / len, ny = dx / len;
        const hw = seg.halfWidth;

        let p1 = { x: seg.x1 + nx * hw, y: seg.y1 + ny * hw };
        let p2 = { x: seg.x2 + nx * hw, y: seg.y2 + ny * hw };
        let p3 = { x: seg.x2 - nx * hw, y: seg.y2 - ny * hw };
        let p4 = { x: seg.x1 - nx * hw, y: seg.y1 - ny * hw };

        const sa = adj.get(`${seg.id}:start`);
        if (sa) { p1 = sa.left; p4 = sa.right; }
        const ea = adj.get(`${seg.id}:end`);
        if (ea) { p2 = ea.right; p3 = ea.left; }

        polygons.push({ id: seg.id, corners: [p1, p2, p3, p4], startKey: ptKey(seg.x1, seg.y1), endKey: ptKey(seg.x2, seg.y2) });
      }

      // Build junction set (endpoints shared by 2+ walls)
      const epCount = new Map<string, number>();
      for (const p of polygons) {
        epCount.set(p.startKey, (epCount.get(p.startKey) ?? 0) + 1);
        epCount.set(p.endKey, (epCount.get(p.endKey) ?? 0) + 1);
      }
      const junctionKeys = new Set<string>();
      for (const [k, c] of epCount) { if (c >= 2) junctionKeys.add(k); }

      // Clip side edges, add end caps at free endpoints only
      const outerEdges = computeOuterEdges(polygons, junctionKeys);

      // Junction fills (cover gaps between per-element fill polygons)
      const fills = miter.junctionFills.map(jf => ({
        points: jf.points.map(p => `${p.x},${p.y}`).join(' '),
        fill: jf.fill,
      }));

      return { edges: outerEdges, fills, color: style.color, width: style.width };
    };

    const walls = processGroup(wallSegs);
    const mep = processGroup(mepSegs);
    return { walls, mep };
  }, [doc.elements, visibleLayers, activeDiscipline]);

  const { walls, mep } = data;
  if (walls.edges.length === 0 && mep.edges.length === 0) return null;

  return (
    <g className="wall-outlines" transform="scale(1,-1)" style={{ pointerEvents: 'none' }}>
      {walls.fills.map((f, i) => (
        <polygon key={`wf${i}`} points={f.points} fill={f.fill} stroke="none" />
      ))}
      {mep.fills.map((f, i) => (
        <polygon key={`mf${i}`} points={f.points} fill={f.fill} stroke="none" />
      ))}
      {walls.edges.map(([a, b], i) => (
        <line key={`w${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          stroke={walls.color} strokeWidth={walls.width} />
      ))}
      {mep.edges.map(([a, b], i) => (
        <line key={`m${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          stroke={mep.color} strokeWidth={mep.width} />
      ))}
    </g>
  );
});
