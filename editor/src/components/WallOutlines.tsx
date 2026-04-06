import React, { useMemo } from 'react';
import type { ProcessedLayer } from '../state/editorTypes.ts';
import type { LineElement } from '../model/elements.ts';
import {
  computeCornerAdjustments,
  computeOuterEdges,
  ptKey,
  type WallSegment,
  type WallPolygon,
} from '../utils/wallMiter.ts';
import { getMaterialFill } from '../renderers/wallRenderer.tsx';

interface WallOutlinesProps {
  layers: ProcessedLayer[];
}

const WALL_TABLES = new Set(['wall', 'curtain_wall', 'structure_wall']);
const MEP_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);

const MEP_FILL: Record<string, string> = {
  duct: '#00b4d815',
  pipe: '#06d6a015',
  conduit: '#ffd16615',
  cable_tray: '#ffd16615',
};

const OUTLINE_STYLES: Record<string, { color: string; width: number }> = {
  wall: { color: '#1a1a2e', width: 0.03 },
  curtain_wall: { color: '#7ec8e3', width: 0.02 },
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
export const WallOutlines = React.memo(function WallOutlines({ layers }: WallOutlinesProps) {
  const data = useMemo(() => {
    const wallSegs: { seg: WallSegment; table: string }[] = [];
    const mepSegs: { seg: WallSegment; table: string }[] = [];

    for (const layer of layers) {
      const isWall = WALL_TABLES.has(layer.tableName);
      const isMep = MEP_TABLES.has(layer.tableName);
      if (!isWall && !isMep) continue;

      for (const el of layer.elements) {
        if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
        const line = el as LineElement;

        let fill = 'none';
        if (isWall) {
          fill = getMaterialFill(el.tableName, line.attrs.material ?? '');
        } else if (isMep) {
          fill = MEP_FILL[el.tableName] ?? 'none';
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
    }

    const processGroup = (items: { seg: WallSegment; table: string }[]) => {
      const emptyResult = {
        edges: [] as [{ x: number; y: number }, { x: number; y: number }][],
        wallFills: [] as { points: string; fill: string }[],
        junctionFills: [] as { points: string; fill: string }[],
        color: '#888', width: 0.02,
      };
      if (items.length === 0) return emptyResult;

      const segs = items.map(i => i.seg);
      const miter = computeCornerAdjustments(segs);
      const adj = miter.adjustments;
      const style = OUTLINE_STYLES[items[0].table] ?? { color: '#888', width: 0.02 };

      // Build per-wall polygons (with miter-adjusted corners)
      const polygons: WallPolygon[] = [];
      const wallFills: { points: string; fill: string }[] = [];
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

        // Miter-adjusted fill polygon
        if (seg.fill !== 'none') {
          wallFills.push({
            points: [p1, p2, p3, p4].map(p => `${p.x},${p.y}`).join(' '),
            fill: seg.fill,
          });
        }
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
      const junctionFills = miter.junctionFills.map(jf => ({
        points: jf.points.map(p => `${p.x},${p.y}`).join(' '),
        fill: jf.fill,
      }));

      return { edges: outerEdges, wallFills, junctionFills, color: style.color, width: style.width };
    };

    const walls = processGroup(wallSegs);
    const mep = processGroup(mepSegs);
    return { walls, mep };
  }, [layers]);

  const { walls, mep } = data;
  if (walls.wallFills.length === 0 && walls.edges.length === 0 && mep.wallFills.length === 0 && mep.edges.length === 0) return null;

  return (
    <g className="wall-outlines" transform="scale(1,-1)" style={{ pointerEvents: 'none' }}>
      {/* Miter-adjusted wall fills */}
      {walls.wallFills.map((f, i) => (
        <polygon key={`wpf${i}`} points={f.points} fill={f.fill} stroke="none" />
      ))}
      {mep.wallFills.map((f, i) => (
        <polygon key={`mpf${i}`} points={f.points} fill={f.fill} stroke="none" />
      ))}
      {/* Junction gap fills */}
      {walls.junctionFills.map((f, i) => (
        <polygon key={`wjf${i}`} points={f.points} fill={f.fill} stroke="none" />
      ))}
      {mep.junctionFills.map((f, i) => (
        <polygon key={`mjf${i}`} points={f.points} fill={f.fill} stroke="none" />
      ))}
      {/* Outer edge outlines */}
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
