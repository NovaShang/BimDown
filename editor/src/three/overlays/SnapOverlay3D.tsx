import { Line } from '@react-three/drei';
import type { SnapResult } from '../../utils/snap.ts';

interface SnapOverlay3DProps {
  snap: SnapResult | null;
  elevation: number;
}

const GUIDE_EXTENT = 200; // meters — long enough to cover the scene

export default function SnapOverlay3D({ snap, elevation }: SnapOverlay3DProps) {
  if (!snap) return null;
  const { guides } = snap;
  if (guides.length === 0) return null;

  const y = elevation + 0.06; // slightly above floor

  return (
    <group>
      {guides.map((g, i) => {
        if (g.type === 'vline') {
          const isGrid = g.label === 'grid';
          // vline in model space: vertical line at x = g.x (varies in model y)
          // In 3D: line along Z axis at x = g.x
          return (
            <Line
              key={i}
              points={[
                [g.x, y, -g.y - GUIDE_EXTENT],
                [g.x, y, -g.y + GUIDE_EXTENT],
              ]}
              color={isGrid ? '#ffd166' : '#ff6b6b'}
              lineWidth={1}
              dashed
              dashSize={isGrid ? 0.15 : 0.3}
              gapSize={0.2}
              opacity={isGrid ? 0.5 : 0.7}
              transparent
            />
          );
        }
        if (g.type === 'hline') {
          const isGrid = g.label === 'grid';
          // hline in model space: horizontal line at y = g.y (varies in model x)
          // In 3D: line along X axis at z = -g.y
          return (
            <Line
              key={i}
              points={[
                [g.x - GUIDE_EXTENT, y, -g.y],
                [g.x + GUIDE_EXTENT, y, -g.y],
              ]}
              color={isGrid ? '#ffd166' : '#ff6b6b'}
              lineWidth={1}
              dashed
              dashSize={isGrid ? 0.15 : 0.3}
              gapSize={0.2}
              opacity={isGrid ? 0.5 : 0.7}
              transparent
            />
          );
        }
        if (g.type === 'point') {
          return (
            <group key={i}>
              <mesh position={[g.x, y, -g.y]}>
                <torusGeometry args={[0.12, 0.02, 8, 24]} />
                <meshBasicMaterial color="#ff6b6b" />
              </mesh>
              <mesh position={[g.x, y, -g.y]}>
                <sphereGeometry args={[0.04, 8, 8]} />
                <meshBasicMaterial color="#ff6b6b" />
              </mesh>
            </group>
          );
        }
        return null;
      })}
    </group>
  );
}
