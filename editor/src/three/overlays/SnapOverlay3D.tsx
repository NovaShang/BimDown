import { Line, Html } from '@react-three/drei';
import type { SnapResult, SnapType } from '../../utils/snap.ts';

interface SnapOverlay3DProps {
  snap: SnapResult | null;
  elevation: number;
}

const GUIDE_EXTENT = 200;
const RENDER_ORDER = 999;

const OBJECT_COLOR = '#ff6b6b';
const EDGE_COLOR = '#4ecdc4';
const ANGLE_COLOR = '#a8e6cf';
const GRID_COLOR = '#ffd166';
const GRIDLINE_COLOR = '#ef476f';

function colorForSnapType(t?: SnapType): string {
  if (!t) return OBJECT_COLOR;
  if (t === 'edge') return EDGE_COLOR;
  if (t === 'angle') return ANGLE_COLOR;
  if (t === 'gridline') return GRIDLINE_COLOR;
  if (t === 'grid') return GRID_COLOR;
  return OBJECT_COLOR;
}

function SnapMarker3D({ x, z, y, snapType }: {
  x: number; z: number; y: number; snapType?: SnapType;
}) {
  const color = colorForSnapType(snapType);
  const s = 0.06;

  switch (snapType) {
    case 'endpoint':
      return (
        <mesh position={[x, y, z]} renderOrder={RENDER_ORDER}>
          <boxGeometry args={[s * 2, s * 2, s * 2]} />
          <meshBasicMaterial color={color} depthTest={false} />
        </mesh>
      );
    case 'center':
      return (
        <mesh position={[x, y, z]} rotation={[0, Math.PI / 4, 0]} renderOrder={RENDER_ORDER}>
          <boxGeometry args={[s * 2, s * 2, s * 2]} />
          <meshBasicMaterial color={color} wireframe depthTest={false} />
        </mesh>
      );
    case 'midpoint':
      return (
        <mesh position={[x, y + s, z]} renderOrder={RENDER_ORDER}>
          <coneGeometry args={[s, s * 2, 3]} />
          <meshBasicMaterial color={color} depthTest={false} />
        </mesh>
      );
    case 'edge':
      return (
        <group>
          <Line
            points={[[x - s * 2, y, z], [x + s * 2, y, z]]}
            color={color} lineWidth={2}
            depthTest={false} renderOrder={RENDER_ORDER}
          />
          <Line
            points={[[x, y, z - s * 2], [x, y, z + s * 2]]}
            color={color} lineWidth={2}
            depthTest={false} renderOrder={RENDER_ORDER}
          />
        </group>
      );
    case 'angle':
      return (
        <mesh position={[x, y, z]} renderOrder={RENDER_ORDER}>
          <sphereGeometry args={[s, 8, 8]} />
          <meshBasicMaterial color={ANGLE_COLOR} depthTest={false} />
        </mesh>
      );
    default:
      return (
        <group>
          <mesh position={[x, y, z]} renderOrder={RENDER_ORDER}>
            <torusGeometry args={[0.12, 0.02, 8, 24]} />
            <meshBasicMaterial color={color} depthTest={false} />
          </mesh>
          <mesh position={[x, y, z]} renderOrder={RENDER_ORDER}>
            <sphereGeometry args={[0.04, 8, 8]} />
            <meshBasicMaterial color={color} depthTest={false} />
          </mesh>
        </group>
      );
  }
}

export default function SnapOverlay3D({ snap, elevation }: SnapOverlay3DProps) {
  if (!snap) return null;
  const { guides } = snap;
  if (guides.length === 0) return null;

  const y = elevation + 0.06;

  return (
    <group>
      {guides.map((g, i) => {
        if (g.type === 'vline') {
          return (
            <Line
              key={i}
              points={[
                [g.x, y, -g.y - GUIDE_EXTENT],
                [g.x, y, -g.y + GUIDE_EXTENT],
              ]}
              color={colorForSnapType(g.snapType)}
              lineWidth={1}
              dashed
              dashSize={0.3}
              gapSize={0.2}
              opacity={0.7}
              transparent
              depthTest={false}
              renderOrder={RENDER_ORDER}
            />
          );
        }
        if (g.type === 'hline') {
          return (
            <Line
              key={i}
              points={[
                [g.x - GUIDE_EXTENT, y, -g.y],
                [g.x + GUIDE_EXTENT, y, -g.y],
              ]}
              color={colorForSnapType(g.snapType)}
              lineWidth={1}
              dashed
              dashSize={0.3}
              gapSize={0.2}
              opacity={0.7}
              transparent
              depthTest={false}
              renderOrder={RENDER_ORDER}
            />
          );
        }
        if (g.type === 'point') {
          return (
            <SnapMarker3D
              key={i}
              x={g.x} z={-g.y} y={y}
              snapType={g.snapType}
            />
          );
        }
        if (g.type === 'edge_segment' && g.x2 != null && g.y2 != null) {
          return (
            <Line
              key={i}
              points={[
                [g.x, y, -g.y],
                [g.x2, y, -g.y2],
              ]}
              color={EDGE_COLOR}
              lineWidth={2}
              opacity={0.5}
              transparent
              depthTest={false}
              renderOrder={RENDER_ORDER}
            />
          );
        }
        if (g.type === 'angle_line' && g.x2 != null && g.y2 != null) {
          return (
            <group key={i}>
              <Line
                points={[
                  [g.x, y, -g.y],
                  [g.x2, y, -g.y2],
                ]}
                color={ANGLE_COLOR}
                lineWidth={1}
                dashed
                dashSize={0.3}
                gapSize={0.2}
                opacity={0.6}
                transparent
                depthTest={false}
                renderOrder={RENDER_ORDER}
              />
              {g.label && (
                <Html
                  position={[
                    g.x + (g.x2 - g.x) * 0.15,
                    y + 0.15,
                    -(g.y + (g.y2! - g.y) * 0.15),
                  ]}
                  style={{
                    color: ANGLE_COLOR,
                    fontSize: '11px',
                    fontFamily: 'monospace',
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                    userSelect: 'none',
                  }}
                >
                  {g.label}
                </Html>
              )}
            </group>
          );
        }
        if (g.type === 'length_ring' && g.x2 != null) {
          const radius = g.x2;
          return (
            <group key={i}>
              <mesh position={[g.x, y, -g.y]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={RENDER_ORDER}>
                <ringGeometry args={[radius - 0.01, radius + 0.01, 64]} />
                <meshBasicMaterial color="#ffa07a" transparent opacity={0.35} side={2} depthTest={false} />
              </mesh>
              {g.label && (
                <Html
                  position={[g.x + radius + 0.15, y + 0.15, -g.y]}
                  style={{
                    color: '#ffa07a',
                    fontSize: '11px',
                    fontFamily: 'monospace',
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                    userSelect: 'none',
                  }}
                >
                  {g.label}
                </Html>
              )}
            </group>
          );
        }
        return null;
      })}
    </group>
  );
}
