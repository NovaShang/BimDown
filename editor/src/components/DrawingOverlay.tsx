import type { DrawingState, Tool } from '../state/editorTypes.ts';
import type { Point } from '../model/elements.ts';
import { resolveLineStrokeWidth } from '../utils/geometry.ts';

function formatLength(meters: number): string {
  if (meters < 1) return `${(meters * 1000).toFixed(0)} mm`;
  return `${meters.toFixed(3)} m`;
}

/** Length label positioned at the midpoint of a line, offset perpendicular to it */
function LengthLabel({ from, to, scale }: { from: Point; to: Point; scale: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return null;

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  // Offset perpendicular to line
  const nx = -dy / len;
  const ny = dx / len;
  const offset = 0.8 / scale;
  const lx = mx + nx * offset;
  const ly = my + ny * offset;
  const fontSize = 1.0 / scale;

  return (
    <text
      x={lx} y={-ly}
      fill="#4fc3f7"
      fontSize={fontSize}
      fontFamily="monospace"
      textAnchor="middle"
      transform="scale(1,-1)"
      opacity={0.9}
    >
      {formatLength(len)}
    </text>
  );
}

interface DrawingOverlayProps {
  drawingState: DrawingState;
  activeTool: Tool;
  scale: number;
  drawingAttrs: Record<string, string>;
  tableName: string | null;
}

export default function DrawingOverlay({ drawingState, activeTool, scale, drawingAttrs, tableName }: DrawingOverlayProps) {
  const { points, cursor } = drawingState;

  if (activeTool === 'draw_line') {
    if (points.length === 1 && cursor) {
      // Show real thickness for walls/ducts/pipes
      const thickness = tableName ? (resolveLineStrokeWidth(tableName, drawingAttrs) ?? 0) : 0;
      const showThick = thickness > 0;
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          {showThick ? (
            <line
              x1={points[0].x} y1={points[0].y}
              x2={cursor.x} y2={cursor.y}
              stroke="#4fc3f7" strokeWidth={thickness} strokeLinecap="butt"
              opacity="0.35"
            />
          ) : null}
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#4fc3f7" strokeWidth={0.12 / scale} strokeDasharray={`${0.6 / scale},${0.3 / scale}`}
          />
          <circle cx={points[0].x} cy={points[0].y} r={0.45 / scale} fill="#4fc3f7" />
          <circle cx={cursor.x} cy={cursor.y} r={0.3 / scale} fill="#4fc3f7" opacity="0.6" />
          <LengthLabel from={points[0]} to={cursor} scale={scale} />
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'relocate') {
    if (points.length === 1 && cursor) {
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#ffa726" strokeWidth={0.12 / scale} strokeDasharray={`${0.6 / scale},${0.3 / scale}`}
          />
          <circle cx={points[0].x} cy={points[0].y} r={0.45 / scale} fill="#ffa726" />
          <circle cx={cursor.x} cy={cursor.y} r={0.3 / scale} fill="#ffa726" opacity="0.6" />
          <LengthLabel from={points[0]} to={cursor} scale={scale} />
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'draw_point') {
    if (cursor) {
      const w = parseFloat(drawingAttrs.size_x || '0.3');
      const h = parseFloat(drawingAttrs.size_y || '0.3');
      const hw = w / 2;
      const hh = h / 2;
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <rect
            x={cursor.x - hw} y={cursor.y - hh}
            width={w} height={h}
            fill="#4fc3f7" opacity="0.25"
            stroke="#4fc3f7" strokeWidth={0.09 / scale}
          />
          <line x1={cursor.x - hw - (0.3 / scale)} y1={cursor.y} x2={cursor.x + hw + (0.3 / scale)} y2={cursor.y} stroke="#4fc3f7" strokeWidth={0.06 / scale} opacity="0.5" />
          <line x1={cursor.x} y1={cursor.y - hh - (0.3 / scale)} x2={cursor.x} y2={cursor.y + hh + (0.3 / scale)} stroke="#4fc3f7" strokeWidth={0.06 / scale} opacity="0.5" />
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'draw_grid') {
    if (points.length === 1 && cursor) {
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#ef476f" strokeWidth={0.12 / scale} strokeDasharray={`${0.45 / scale},${0.3 / scale}`}
            opacity="0.6"
          />
          <circle cx={points[0].x} cy={points[0].y} r={0.45 / scale} fill="none" stroke="#ef476f" strokeWidth={0.08 / scale} opacity="0.6" />
          <circle cx={cursor.x} cy={cursor.y} r={0.3 / scale} fill="#ef476f" opacity="0.4" />
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'draw_hosted') {
    // points[0] = start, cursor = end of the hosted span on the wall
    if (points.length === 1 && cursor) {
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#4fc3f7" strokeWidth={0.3 / scale}
            opacity="0.45"
          />
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#4fc3f7" strokeWidth={0.08 / scale}
          />
          <circle cx={points[0].x} cy={points[0].y} r={0.3 / scale} fill="#4fc3f7" opacity="0.7" />
          <circle cx={cursor.x} cy={cursor.y} r={0.3 / scale} fill="#4fc3f7" opacity="0.7" />
          <LengthLabel from={points[0]} to={cursor} scale={scale} />
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'draw_polygon') {
    if (points.length === 0 && !cursor) return null;

    const allPts = cursor ? [...points, cursor] : points;
    if (allPts.length < 2 && !cursor) return null;

    const polyPoints = allPts.map(p => `${p.x},${p.y}`).join(' ');

    return (
      <g className="drawing-overlay" transform="scale(1,-1)">
        {/* Fill preview */}
        {allPts.length >= 3 && (
          <polygon
            points={polyPoints}
            fill="#4fc3f7" fillOpacity="0.15"
            stroke="#4fc3f7" strokeWidth={0.15 / scale} strokeDasharray={`${0.6 / scale},${0.3 / scale}`}
          />
        )}
        {/* Lines between placed points */}
        {points.map((p, i) => {
          const next = i < points.length - 1 ? points[i + 1] : cursor;
          if (!next) return null;
          return (
            <line
              key={i}
              x1={p.x} y1={p.y} x2={next.x} y2={next.y}
              stroke="#4fc3f7" strokeWidth={0.24 / scale}
            />
          );
        })}
        {/* Closing line preview */}
        {cursor && points.length >= 2 && (
          <line
            x1={allPts[allPts.length - 1].x} y1={allPts[allPts.length - 1].y}
            x2={points[0].x} y2={points[0].y}
            stroke="#4fc3f7" strokeWidth={0.15 / scale} strokeDasharray={`${0.45 / scale},${0.3 / scale}`} opacity="0.5"
          />
        )}
        {/* Vertex dots */}
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={0.36 / scale} fill="#4fc3f7" />
        ))}
        {/* Cursor dot */}
        {cursor && (
          <circle cx={cursor.x} cy={cursor.y} r={0.24 / scale} fill="#4fc3f7" opacity="0.6" />
        )}
      </g>
    );
  }

  return null;
}
