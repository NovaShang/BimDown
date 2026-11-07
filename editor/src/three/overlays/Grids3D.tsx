import { useEffect, useMemo } from 'react';
import { CanvasTexture, SRGBColorSpace } from 'three';
import { Line } from '@react-three/drei';
import { useEditorState } from '../../state/EditorContext.tsx';

const GRID_COLOR = '#ef476f';

/** Grid bubble as a screen-sized sprite (a DOM <Html> label per bubble broke
 *  unmounting the 3D view: React then removed nodes drei had moved). */
function GridBubble({ position, label }: { position: [number, number, number]; label: string }) {
  const texture = useMemo(() => {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = GRID_COLOR;
      ctx.stroke();
      ctx.fillStyle = GRID_COLOR;
      ctx.font = `700 ${label.length > 2 ? 22 : 30}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, size / 2, size / 2 + 1);
    }
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, [label]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={position} scale={[0.026, 0.026, 1]} renderOrder={10} raycast={() => null}>
      <spriteMaterial map={texture} sizeAttenuation={false} depthTest={false} transparent />
    </sprite>
  );
}

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
            {ends.map((p, i) => <GridBubble key={i} position={p} label={g.number || g.id} />)}
          </group>
        );
      })}
    </group>
  );
}
