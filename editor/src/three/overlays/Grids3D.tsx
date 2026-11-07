import { Html, Line } from '@react-three/drei';
import { useEditorState } from '../../state/EditorContext.tsx';

const GRID_COLOR = '#ef476f';

/**
 * Grid axes in the 3D view (view option `showGrids3D`): dash-dot lines at the
 * current level's elevation with a bubble label at the start of each axis (and
 * the end too when "bubbles at both ends" is on). Not pickable.
 */
export default function Grids3D() {
  const { grids, viewOptions, currentLevel, project } = useEditorState();
  if (!viewOptions.showGrids3D || grids.length === 0) return null;
  const elev = (project?.levels.find(l => l.id === currentLevel)?.elevation ?? 0) + 0.01;
  return (
    <group raycast={() => null}>
      {grids.map(g => {
        if (g.x1 === g.x2 && g.y1 === g.y2) return null;
        // Plan (x, y) → 3D (x, elev, −y).
        const a: [number, number, number] = [g.x1, elev, -g.y1];
        const b: [number, number, number] = [g.x2, elev, -g.y2];
        const ends = viewOptions.gridBubblesBothEnds ? [a, b] : [a];
        return (
          <group key={g.id}>
            <Line points={[a, b]} color={GRID_COLOR} lineWidth={1.2}
              dashed dashSize={0.8} gapSize={0.25} transparent opacity={0.85} raycast={() => null} />
            {ends.map((p, i) => (
              <Html key={i} position={p} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
                <div style={{
                  width: 22, height: 22, borderRadius: 11, border: `2px solid ${GRID_COLOR}`,
                  background: '#fff', color: GRID_COLOR, font: '700 11px Inter, sans-serif',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none',
                }}>
                  {g.number || g.id}
                </div>
              </Html>
            ))}
          </group>
        );
      })}
    </group>
  );
}
