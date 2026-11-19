/**
 * Preview of the modify tools (rotate / mirror / array / align / offset /
 * paste): ghost outlines of the result, the rotate centre and rays, the
 * mirror axis or align reference, the candidate line under the cursor.
 */
import type { DrawingState } from '../state/editorTypes.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { tessellateArc } from '../geometry/arc.ts';

const INK = '#ff8f00';
const GHOST = '#2196f3';

function Ghost({ el, scale }: { el: CanonicalElement; scale: number }) {
  const sw = 0.05 / scale;
  switch (el.geometry) {
    case 'line':
    case 'spatial_line': {
      if (el.tableName === 'connector') return null;
      const w = Math.max(el.strokeWidth, 0.04);
      const pts = el.arc ? tessellateArc(el.start, el.end, el.arc) : [el.start, el.end];
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
      return (
        <g>
          <path d={d} fill="none" stroke={GHOST} strokeOpacity={0.25} strokeWidth={w} strokeLinecap="butt" />
          <path d={d} fill="none" stroke={GHOST} strokeWidth={sw} />
        </g>
      );
    }
    case 'point': {
      if (el.tableName === 'connector' || el.tableName === 'tag' && (el.attrs.x ?? '') === '') return null;
      const rot = parseFloat(el.attrs.rotation ?? '') || 0;
      const w = Math.max(el.width, 0.1), h = Math.max(el.height, 0.1);
      return (
        <rect x={-w / 2} y={-h / 2} width={w} height={h} transform={`translate(${el.position.x},${el.position.y}) rotate(${rot})`}
          fill={GHOST} fillOpacity={0.15} stroke={GHOST} strokeWidth={sw} />
      );
    }
    case 'polygon':
      return (
        <polygon points={el.vertices.map(v => `${v.x},${v.y}`).join(' ')} fill={GHOST} fillOpacity={0.08} stroke={GHOST} strokeWidth={sw} />
      );
  }
}

function Line({ a, b, scale, dashed, color = INK }: { a: Point; b: Point; scale: number; dashed?: boolean; color?: string }) {
  return (
    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={0.1 / scale}
      strokeDasharray={dashed ? `${0.5 / scale},${0.25 / scale}` : undefined} />
  );
}

/** A long line through a segment (mirror axis / align reference read as infinite). */
function extend(a: Point, b: Point, by: number): [Point, Point] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  return [{ x: a.x - ux * by, y: a.y - uy * by }, { x: b.x + ux * by, y: b.y + uy * by }];
}

export default function ModifyOverlay({ drawingState, activeTool, scale }: { drawingState: DrawingState; activeTool: string; scale: number }) {
  const m = drawingState.modify;
  if (!m) return null;
  const cursor = drawingState.cursor;
  const r = 0.25 / scale;
  return (
    <g className="drawing-overlay" transform="scale(1,-1)" pointerEvents="none" data-testid="modify-overlay">
      {m.preview?.map((el, i) => <Ghost key={i} el={el} scale={scale} />)}
      {m.axis && (() => {
        const [a, b] = activeTool === 'mirror' ? extend(m.axis.start, m.axis.end, 50 / Math.max(scale, 0.01)) : [m.axis.start, m.axis.end];
        return <Line a={a} b={b} scale={scale} dashed />;
      })()}
      {m.hoverLine && <Line a={m.hoverLine.start} b={m.hoverLine.end} scale={scale} color={activeTool === 'mirror' ? INK : GHOST} dashed={activeTool === 'mirror'} />}
      {activeTool === 'rotate' && m.center && !m.pickCenter && (
        <g>
          <circle cx={m.center.x} cy={m.center.y} r={r} fill="none" stroke={INK} strokeWidth={0.08 / scale} />
          <line x1={m.center.x - 2 * r} y1={m.center.y} x2={m.center.x + 2 * r} y2={m.center.y} stroke={INK} strokeWidth={0.06 / scale} />
          <line x1={m.center.x} y1={m.center.y - 2 * r} x2={m.center.x} y2={m.center.y + 2 * r} stroke={INK} strokeWidth={0.06 / scale} />
          {m.ref && <Line a={m.center} b={m.ref} scale={scale} />}
          {m.ref && cursor && <Line a={m.center} b={cursor} scale={scale} dashed />}
          {m.ref && cursor && m.angle !== undefined && (
            <text x={cursor.x + r * 2} y={-(cursor.y + r * 2)} transform="scale(1,-1)" fill={INK} fontSize={0.9 / scale} fontFamily="monospace">{m.angle}°</text>
          )}
        </g>
      )}
      {(activeTool === 'array' || activeTool === 'rotate' && m.pickCenter) && m.center && (
        <circle cx={m.center.x} cy={m.center.y} r={r} fill="none" stroke={INK} strokeWidth={0.08 / scale} />
      )}
      {activeTool === 'array' && m.ref && <circle cx={m.ref.x} cy={m.ref.y} r={r * 0.6} fill={INK} />}
      {drawingState.pick?.point && activeTool === 'align' && (
        <circle cx={drawingState.pick.point.x} cy={drawingState.pick.point.y} r={r} fill={INK} />
      )}
    </g>
  );
}
