import type { DrawingState, Tool } from '../state/editorTypes.ts';

interface DrawingOverlayProps {
  drawingState: DrawingState;
  activeTool: Tool;
}

export default function DrawingOverlay({ drawingState, activeTool }: DrawingOverlayProps) {
  const { points, cursor } = drawingState;

  if (activeTool === 'draw_line') {
    if (points.length === 1 && cursor) {
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#4fc3f7" strokeWidth="0.1" strokeDasharray="0.2,0.1"
          />
          <circle cx={points[0].x} cy={points[0].y} r="0.15" fill="#4fc3f7" />
          <circle cx={cursor.x} cy={cursor.y} r="0.1" fill="#4fc3f7" opacity="0.6" />
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'draw_point') {
    if (cursor) {
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <rect
            x={cursor.x - 0.15} y={cursor.y - 0.15}
            width="0.3" height="0.3"
            fill="#4fc3f7" opacity="0.4"
            stroke="#4fc3f7" strokeWidth="0.05"
          />
          <line x1={cursor.x - 0.3} y1={cursor.y} x2={cursor.x + 0.3} y2={cursor.y} stroke="#4fc3f7" strokeWidth="0.02" opacity="0.5" />
          <line x1={cursor.x} y1={cursor.y - 0.3} x2={cursor.x} y2={cursor.y + 0.3} stroke="#4fc3f7" strokeWidth="0.02" opacity="0.5" />
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
            stroke="#4fc3f7" strokeWidth="0.05" strokeDasharray="0.2,0.1"
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
              stroke="#4fc3f7" strokeWidth="0.08"
            />
          );
        })}
        {/* Closing line preview */}
        {cursor && points.length >= 2 && (
          <line
            x1={allPts[allPts.length - 1].x} y1={allPts[allPts.length - 1].y}
            x2={points[0].x} y2={points[0].y}
            stroke="#4fc3f7" strokeWidth="0.05" strokeDasharray="0.15,0.1" opacity="0.5"
          />
        )}
        {/* Vertex dots */}
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="0.12" fill="#4fc3f7" />
        ))}
        {/* Cursor dot */}
        {cursor && (
          <circle cx={cursor.x} cy={cursor.y} r="0.08" fill="#4fc3f7" opacity="0.6" />
        )}
      </g>
    );
  }

  return null;
}
