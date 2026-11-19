import { useRef, useEffect, useCallback } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { OverlayItem, OverlayAnchor } from '../hooks/useOverlayItems.ts';

function anchorTranslate(anchor: OverlayAnchor | undefined): string {
  const tx = !anchor || anchor.includes('left') ? '0%'
    : anchor.includes('right') ? '-100%' : '-50%';
  const ty = !anchor || anchor.includes('top') ? '0%'
    : anchor.includes('bottom') ? '-100%' : '-50%';
  return `translate(${tx}, ${ty})`;
}

interface CanvasOverlay3DProjectorProps {
  items: OverlayItem[];
  elevation: number;
  /** Map of item id → DOM element, managed by the outer React tree */
  itemEls: Map<string, HTMLDivElement>;
}

/**
 * Runs inside the R3F Canvas context. Projects model positions to screen
 * coords every frame and updates DOM elements imperatively.
 * Returns null — never renders any React elements inside the R3F tree.
 */
function CanvasOverlay3DProjector({ items, elevation, itemEls }: CanvasOverlay3DProjectorProps) {
  const { camera, gl } = useThree();
  const worldPos = useRef(new Vector3());

  const syncPositions = useCallback(() => {
    const rect = gl.domElement.getBoundingClientRect();

    for (const item of items) {
      const el = itemEls.get(item.id);
      if (!el) continue;

      worldPos.current.set(item.position.x, elevation, -item.position.y);
      const ndc = worldPos.current.clone().project(camera);
      const screenX = (ndc.x * 0.5 + 0.5) * rect.width + (item.offset?.x ?? 0);
      const screenY = (-ndc.y * 0.5 + 0.5) * rect.height + (item.offset?.y ?? 0);

      if (ndc.z > 1) {
        el.style.display = 'none';
      } else {
        el.style.display = '';
        el.style.transform = `translate(${screenX}px, ${screenY}px) ${anchorTranslate(item.anchor)}`;
      }
    }
  }, [items, elevation, camera, gl, itemEls]);

  useFrame(syncPositions);

  useEffect(() => {
    syncPositions();
  }, [items, syncPositions]);

  return null;
}

/**
 * Outer container rendered in the normal React DOM tree (outside R3F Canvas).
 */
function CanvasOverlay3DContainer({ children }: { children?: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: 20,
      }}
    >
      {children}
    </div>
  );
}

export { CanvasOverlay3DProjector, CanvasOverlay3DContainer };
