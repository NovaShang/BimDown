/**
 * Plan preview for the wall placement tool (tools/wallDrawTool.ts): the walls
 * the next click creates (true thickness, after location line / offset), the
 * clicked path, the chain start to close on, a length + angle readout and the
 * typed-dimension badge.
 */
import { useTranslation } from 'react-i18next';
import type { DrawingState, TypedInput } from '../state/editorTypes.ts';
import type { Point } from '../model/elements.ts';
import type { ProjectUnit } from '../types.ts';
import { tessellateArc, pointOnArc } from '../geometry/arc.ts';
import { formatLength } from '../utils/units.ts';
import { wallDrawOptions } from '../tools/wallDrawTool.ts';

const C = '#4fc3f7';

function footprint(span: NonNullable<DrawingState['ghost']>[number], t: number): Point[] {
  const hw = Math.max(t, 0.02) / 2;
  if (span.arc) {
    const pts = tessellateArc(span.start, span.end, span.arc, 0.15);
    const left: Point[] = [], right: Point[] = [];
    pts.forEach((p, i) => {
      const { tangent } = pointOnArc(span.start, span.end, span.arc!, i / (pts.length - 1));
      left.push({ x: p.x - tangent.y * hw, y: p.y + tangent.x * hw });
      right.push({ x: p.x + tangent.y * hw, y: p.y - tangent.x * hw });
    });
    return [...left, ...right.reverse()];
  }
  const dx = span.end.x - span.start.x, dy = span.end.y - span.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [];
  const nx = -dy / len * hw, ny = dx / len * hw;
  return [
    { x: span.start.x + nx, y: span.start.y + ny }, { x: span.end.x + nx, y: span.end.y + ny },
    { x: span.end.x - nx, y: span.end.y - ny }, { x: span.start.x - nx, y: span.start.y - ny },
  ];
}

/** Typed length / angle readout next to the cursor (also used by Move / Copy). */
export function TypedBadge({ at, typed, scale, labels }: {
  at: Point; typed: TypedInput; scale: number; labels: [string, string];
}) {
  const fs = 0.9 / scale;
  const caret = (f: TypedInput['field']) => (typed.field === f ? '▏' : '');
  const text = `${labels[0]} ${typed.length}${caret('length')}   ${labels[1]} ${typed.angle}${caret('angle')}`;
  const w = Math.max(6, text.length * 0.62) * fs;
  // SVG (y-down) coordinates, just below-right of the cursor.
  const x = at.x + 0.8 / scale, y = -at.y + 2.2 / scale;
  return (
    <g pointerEvents="none">
      <rect x={x} y={y - fs * 1.1} width={w} height={fs * 1.5} rx={fs * 0.3}
        fill="#0b1724" fillOpacity={0.85} stroke={C} strokeWidth={0.04 / scale} />
      <text x={x + fs * 0.4} y={y} fill="#fff" fontSize={fs} fontFamily="monospace">{text}</text>
    </g>
  );
}

export default function WallDrawPreview({ drawingState, drawingAttrs, thickness, scale, projectUnit }: {
  drawingState: DrawingState;
  drawingAttrs: Record<string, string>;
  thickness: number;
  scale: number;
  projectUnit: ProjectUnit;
}) {
  const { t } = useTranslation();
  const { points, cursor, ghost, chain, arcEnd, typed } = drawingState;
  const mode = wallDrawOptions(drawingAttrs).mode;
  const anchor = points[0];
  const sw = 0.08 / scale;
  const fs = 1.0 / scale;
  const target = arcEnd ?? cursor;
  const len = anchor && target ? Math.hypot(target.x - anchor.x, target.y - anchor.y) : 0;
  const ang = anchor && target ? Math.atan2(target.y - anchor.y, target.x - anchor.x) * 180 / Math.PI : 0;
  const closeTarget = chain && chain.path.length >= 3 ? chain.path[0] : null;

  return (
    <g className="drawing-overlay" pointerEvents="none">
      <g transform="scale(1,-1)">
        {ghost?.map((g, i) => {
          const fp = footprint(g, thickness);
          return fp.length > 2 ? (
            <polygon key={i} points={fp.map(p => `${p.x},${p.y}`).join(' ')}
              fill={C} fillOpacity={0.3} stroke={C} strokeWidth={sw} />
          ) : null;
        })}
        {anchor && arcEnd && (
          <line x1={anchor.x} y1={anchor.y} x2={arcEnd.x} y2={arcEnd.y}
            stroke={C} strokeWidth={sw} strokeDasharray={`${0.4 / scale},${0.25 / scale}`} opacity={0.6} />
        )}
        {anchor && cursor && mode !== 'rect' && !arcEnd && (
          <line x1={anchor.x} y1={anchor.y} x2={cursor.x} y2={cursor.y}
            stroke={C} strokeWidth={sw} strokeDasharray={`${0.6 / scale},${0.3 / scale}`} />
        )}
        {closeTarget && (
          <circle cx={closeTarget.x} cy={closeTarget.y} r={0.6 / scale} fill="none" stroke={C} strokeWidth={sw} />
        )}
        {anchor && <circle cx={anchor.x} cy={anchor.y} r={0.4 / scale} fill={C} />}
        {cursor && <circle cx={cursor.x} cy={cursor.y} r={0.28 / scale} fill={C} opacity={0.6} />}
      </g>
      {anchor && cursor && !typed && mode !== 'rect' && len > 1e-6 && (
        <text x={cursor.x + 0.8 / scale} y={-(cursor.y + 0.8 / scale)} fill={C} fontSize={fs} fontFamily="monospace">
          {`${formatLength(len, projectUnit)}  ${((ang % 360) + 360) % 360 < 0.05 ? 0 : (((ang % 360) + 360) % 360).toFixed(1)}°`}
        </text>
      )}
      {anchor && cursor && !typed && mode === 'rect' && (
        <text x={cursor.x + 0.8 / scale} y={-(cursor.y + 0.8 / scale)} fill={C} fontSize={fs} fontFamily="monospace">
          {`${formatLength(Math.abs(cursor.x - anchor.x), projectUnit)} × ${formatLength(Math.abs(cursor.y - anchor.y), projectUnit)}`}
        </text>
      )}
      {typed && cursor && (
        <TypedBadge at={cursor} typed={typed} scale={scale}
          labels={mode === 'rect'
            ? [t('drawing.typedWidth', 'W'), t('drawing.typedHeight', 'H')]
            : [t('drawing.typedLength', 'L'), t('drawing.typedAngle', '∠')]} />
      )}
    </g>
  );
}
