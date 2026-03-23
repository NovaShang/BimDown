import { Line, Html } from '@react-three/drei';
import { useEditorState } from '../../state/EditorContext.tsx';
import { resolveLineStrokeWidth } from '../../utils/geometry.ts';
import type { Point } from '../../model/elements.ts';

function formatLength(meters: number): string {
  if (meters < 1) return `${(meters * 1000).toFixed(0)} mm`;
  return `${meters.toFixed(3)} m`;
}

function LengthLabel3D({ from, to, elevation }: { from: Point; to: Point; elevation: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return null;

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const nx = -dy / len;
  const ny = dx / len;
  const offset = 0.3;

  return (
    <Html
      position={[mx + nx * offset, elevation + 0.15, -(my + ny * offset)]}
      style={{
        color: '#4fc3f7',
        fontSize: '11px',
        fontFamily: 'monospace',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        textShadow: '0 0 3px rgba(0,0,0,0.5)',
      }}
      center
    >
      {formatLength(len)}
    </Html>
  );
}

interface DrawingOverlay3DProps {
  elevation: number;
}

/** Convert model (x, y) to 3D position at given elevation. */
function toWorld(x: number, y: number, elev: number): [number, number, number] {
  return [x, elev + 0.05, -y]; // slightly above floor to avoid z-fighting
}

export default function DrawingOverlay3D({ elevation }: DrawingOverlay3DProps) {
  const { drawingState, activeTool, drawingAttrs, drawingTarget } = useEditorState();
  if (!drawingState) return null;

  const { points, cursor } = drawingState;
  const tableName = drawingTarget?.tableName ?? null;

  if (activeTool === 'draw_line') {
    if (points.length === 1 && cursor) {
      const thickness = tableName ? (resolveLineStrokeWidth(tableName, drawingAttrs) ?? 0) : 0;
      return (
        <group>
          {/* Thickness preview */}
          {thickness > 0 && (
            <Line
              points={[toWorld(points[0].x, points[0].y, elevation), toWorld(cursor.x, cursor.y, elevation)]}
              color="#4fc3f7"
              lineWidth={1}
              opacity={0.35}
              transparent
            />
          )}
          {/* Center line (dashed) */}
          <Line
            points={[toWorld(points[0].x, points[0].y, elevation), toWorld(cursor.x, cursor.y, elevation)]}
            color="#4fc3f7"
            lineWidth={2}
            dashed
            dashSize={0.3}
            gapSize={0.15}
          />
          {/* Start dot */}
          <mesh position={toWorld(points[0].x, points[0].y, elevation)}>
            <sphereGeometry args={[0.15, 16, 16]} />
            <meshBasicMaterial color="#4fc3f7" />
          </mesh>
          {/* Cursor dot */}
          <mesh position={toWorld(cursor.x, cursor.y, elevation)}>
            <sphereGeometry args={[0.1, 16, 16]} />
            <meshBasicMaterial color="#4fc3f7" transparent opacity={0.6} />
          </mesh>
          <LengthLabel3D from={points[0]} to={cursor} elevation={elevation} />
        </group>
      );
    }
    return null;
  }

  if (activeTool === 'draw_point') {
    if (cursor) {
      const w = parseFloat(drawingAttrs.size_x || '0.3');
      const h = parseFloat(drawingAttrs.size_y || '0.3');
      const pos = toWorld(cursor.x, cursor.y, elevation);
      return (
        <group>
          <mesh position={pos}>
            <boxGeometry args={[w, 0.1, h]} />
            <meshBasicMaterial color="#4fc3f7" transparent opacity={0.3} wireframe />
          </mesh>
          {/* Crosshair lines */}
          <Line
            points={[
              [pos[0] - w, pos[1], pos[2]],
              [pos[0] + w, pos[1], pos[2]],
            ]}
            color="#4fc3f7"
            lineWidth={1}
            opacity={0.5}
            transparent
          />
          <Line
            points={[
              [pos[0], pos[1], pos[2] - h],
              [pos[0], pos[1], pos[2] + h],
            ]}
            color="#4fc3f7"
            lineWidth={1}
            opacity={0.5}
            transparent
          />
        </group>
      );
    }
    return null;
  }

  if (activeTool === 'draw_polygon') {
    if (points.length === 0 && !cursor) return null;

    const allPts = cursor ? [...points, cursor] : points;
    return (
      <group>
        {/* Lines between placed points */}
        {points.map((p, i) => {
          const next = i < points.length - 1 ? points[i + 1] : cursor;
          if (!next) return null;
          return (
            <Line
              key={i}
              points={[toWorld(p.x, p.y, elevation), toWorld(next.x, next.y, elevation)]}
              color="#4fc3f7"
              lineWidth={2}
            />
          );
        })}
        {/* Closing line preview */}
        {cursor && points.length >= 2 && (
          <Line
            points={[
              toWorld(allPts[allPts.length - 1].x, allPts[allPts.length - 1].y, elevation),
              toWorld(points[0].x, points[0].y, elevation),
            ]}
            color="#4fc3f7"
            lineWidth={1}
            dashed
            dashSize={0.2}
            gapSize={0.15}
            opacity={0.5}
            transparent
          />
        )}
        {/* Vertex dots */}
        {points.map((p, i) => (
          <mesh key={i} position={toWorld(p.x, p.y, elevation)}>
            <sphereGeometry args={[0.12, 16, 16]} />
            <meshBasicMaterial color="#4fc3f7" />
          </mesh>
        ))}
        {/* Cursor dot */}
        {cursor && (
          <mesh position={toWorld(cursor.x, cursor.y, elevation)}>
            <sphereGeometry args={[0.08, 16, 16]} />
            <meshBasicMaterial color="#4fc3f7" transparent opacity={0.6} />
          </mesh>
        )}
      </group>
    );
  }

  return null;
}
