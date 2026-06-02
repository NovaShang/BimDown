/**
 * Ghost-line preview for the active port-drag gesture.
 *
 * Subscribes to portDragTool's tiny pub/sub so the SVG re-renders on every
 * mousemove. When no gesture is in flight it renders nothing.
 */
import { useEffect, useState } from 'react';
import {
  getPortDragSnapshot,
  isPortDragActive,
  subscribePortDrag,
} from '../tools/portDragTool.ts';
import { orthoRoute } from '../utils/orthoRoute.ts';

interface PortDragOverlayProps {
  scale: number;
}

export default function PortDragOverlay({ scale }: PortDragOverlayProps) {
  const [, setTick] = useState(0);

  useEffect(() => subscribePortDrag(() => setTick((t) => t + 1)), []);

  if (!isPortDragActive()) return null;
  const snap = getPortDragSnapshot();
  if (!snap) return null;

  const poly = orthoRoute(snap.origin, snap.cursor, { sourceDir: snap.outwardDir });
  if (poly.length < 2) return null;

  const isHit = snap.targetRef !== null || snap.pipeHitPoint !== null;
  const stroke = isHit ? '#06d6a0' : '#3a7bff';
  const strokeWidth = 0.04 / scale;
  const dashed = !isHit ? `${0.18 / scale} ${0.12 / scale}` : undefined;

  const polylinePoints = poly.map((p) => `${p.x},${-p.y}`).join(' ');

  return (
    <g pointerEvents="none">
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={dashed}
        points={polylinePoints}
        opacity={0.85}
      />
      {/* Origin dot */}
      <circle
        cx={snap.origin.x}
        cy={-snap.origin.y}
        r={0.06 / scale}
        fill={stroke}
      />
      {/* Landing indicator: port snap → ring; T-junction → small cross. */}
      {snap.targetRef ? (
        <circle
          cx={poly[poly.length - 1].x}
          cy={-poly[poly.length - 1].y}
          r={0.12 / scale}
          fill="none"
          stroke={stroke}
          strokeWidth={0.025 / scale}
        />
      ) : snap.pipeHitPoint ? (
        <g>
          <circle
            cx={snap.pipeHitPoint.x}
            cy={-snap.pipeHitPoint.y}
            r={0.10 / scale}
            fill="none"
            stroke={stroke}
            strokeWidth={0.025 / scale}
          />
          <line
            x1={snap.pipeHitPoint.x - 0.08 / scale} y1={-snap.pipeHitPoint.y}
            x2={snap.pipeHitPoint.x + 0.08 / scale} y2={-snap.pipeHitPoint.y}
            stroke={stroke} strokeWidth={0.025 / scale}
          />
          <line
            x1={snap.pipeHitPoint.x} y1={-snap.pipeHitPoint.y - 0.08 / scale}
            x2={snap.pipeHitPoint.x} y2={-snap.pipeHitPoint.y + 0.08 / scale}
            stroke={stroke} strokeWidth={0.025 / scale}
          />
        </g>
      ) : (
        <circle
          cx={snap.cursor.x}
          cy={-snap.cursor.y}
          r={0.05 / scale}
          fill={stroke}
        />
      )}
    </g>
  );
}
