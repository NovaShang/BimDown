import { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { useEditorState } from '../state/EditorContext.tsx';
import SceneContent from './SceneContent.tsx';
import MarqueeSelection from '../components/MarqueeSelection.tsx';
import { CanvasOverlay3DProjector, CanvasOverlay3DContainer } from './CanvasOverlay3D.tsx';
import { parseLayer } from '../model/parse.ts';
import { computeBounds } from '../model/elements.ts';
import type { OverlayItem } from '../hooks/useOverlayItems.ts';

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

interface Canvas3DProps {
  overlayItems?: OverlayItem[];
  elevation?: number;
}

export default function Canvas3D({ overlayItems, elevation = 0 }: Canvas3DProps) {
  const { position, far } = useInitialCamera();
  const state = useEditorState();

  // Track overlay item DOM elements via callback refs
  const itemElsRef = useRef(new Map<string, HTMLDivElement>());

  // Read --bg-canvas CSS variable for theme-aware 3D background
  const [bgColor, setBgColor] = useState('#1a1d23');
  useEffect(() => {
    const update = () => {
      const c = getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim();
      if (c) setBgColor(c);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const items = overlayItems ?? [];

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        shadows="soft"
        camera={{ position, fov: 50, near: 0.1, far }}
        gl={{ antialias: true, toneMapping: 4 /* ACESFilmicToneMapping */ }}
        raycaster={{ params: { Line: { threshold: 0.5 } } as any }}
      >
        <color attach="background" args={[bgColor]} />
        <fog attach="fog" args={[bgColor, far * 0.3, far * 0.9]} />
        <SceneContent />
        {items.length > 0 && (
          <CanvasOverlay3DProjector
            items={items}
            elevation={elevation}
            itemEls={itemElsRef.current}
          />
        )}
      </Canvas>
      {state.marquee && <MarqueeSelection marquee={state.marquee} />}
      <CanvasOverlay3DContainer>
        {items.map((item) => (
          <div
            key={item.id}
            ref={(el) => {
              if (el) itemElsRef.current.set(item.id, el);
              else itemElsRef.current.delete(item.id);
            }}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              pointerEvents: 'auto',
              willChange: 'transform',
            }}
          >
            {item.content}
          </div>
        ))}
      </CanvasOverlay3DContainer>
    </div>
  );
}
