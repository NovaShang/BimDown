import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { useEditorState } from '../state/EditorContext.tsx';
import SceneContent from './SceneContent.tsx';
import { parseLayer } from '../model/parse.ts';
import { computeBounds } from '../model/elements.ts';

/** Derive initial camera position from element bounds so the camera
 *  starts roughly above the model center, even before Bounds.fit() runs. */
function useInitialCamera(): { position: [number, number, number]; far: number } {
  const { project, currentLevel } = useEditorState();

  return useMemo(() => {
    if (!project) return { position: [30, 40, 30], far: 2000 };

    const floorsToTry = [project.floors.get(currentLevel), ...project.floors.values()];
    for (const floor of floorsToTry) {
      if (!floor) continue;
      const allElements = floor.layers.flatMap(l => parseLayer(l));
      const bounds = computeBounds(allElements);
      if (bounds) {
        const cx = bounds.x + bounds.w / 2;
        const cz = -(bounds.y + bounds.h / 2);
        const size = Math.max(bounds.w, bounds.h);
        const dist = size * 2;
        return {
          position: [cx + dist, dist, cz + dist] as [number, number, number],
          far: Math.max(2000, dist * 10),
        };
      }
    }
    return { position: [30, 40, 30], far: 2000 };
  }, [project, currentLevel]);
}

export default function Canvas3D() {
  const { position, far } = useInitialCamera();

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Canvas
        shadows="soft"
        camera={{ position, fov: 50, near: 0.1, far }}
        gl={{ antialias: true, toneMapping: 4 /* ACESFilmicToneMapping */ }}
        raycaster={{ params: { Line: { threshold: 0.5 } } }}
      >
        <color attach="background" args={['#e8ecf1']} />
        <fog attach="fog" args={['#e8ecf1', far * 0.3, far * 0.9]} />
        <SceneContent />
      </Canvas>
    </div>
  );
}
