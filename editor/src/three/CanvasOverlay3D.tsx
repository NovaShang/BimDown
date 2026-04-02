import { useRef, useEffect, useCallback } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import { createPortal } from 'react-dom';
import type { OverlayItem } from '../hooks/useOverlayItems.ts';

interface CanvasOverlay3DInnerProps {
  items: OverlayItem[];
  elevation: number;
  containerEl: HTMLDivElement;
}

/**
 * Inner component that runs inside the Three.js Canvas context.
 * Projects model positions to screen coords every frame and updates
 * DOM elements in a portal outside the canvas.
 */
function CanvasOverlay3DInner({ items, elevation, containerEl }: CanvasOverlay3DInnerProps) {
  const { camera, gl } = useThree();
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const worldPos = useRef(new Vector3());

  const syncPositions = useCallback(() => {
    const rect = gl.domElement.getBoundingClientRect();

    for (const item of items) {
      const el = itemRefs.current.get(item.id);
      if (!el) continue;

      // Model → Three.js world coords
      worldPos.current.set(item.position.x, elevation, -item.position.y);

      // Project to NDC then to screen
      const ndc = worldPos.current.clone().project(camera);
      const screenX = (ndc.x * 0.5 + 0.5) * rect.width + (item.offset?.x ?? 0);
      const screenY = (-ndc.y * 0.5 + 0.5) * rect.height + (item.offset?.y ?? 0);

      // Hide if behind camera
      if (ndc.z > 1) {
        el.style.display = 'none';
      } else {
        el.style.display = '';
        el.style.transform = `translate(${screenX}px, ${screenY}px)`;
      }
    }
  }, [items, elevation, camera, gl]);

  // Update every frame
  useFrame(syncPositions);

  // Also sync immediately on item changes
  useEffect(() => {
    syncPositions();
  }, [items, syncPositions]);

  if (items.length === 0) return null;

  return createPortal(
    <>
      {items.map((item) => (
        <div
          key={item.id}
          ref={(el) => {
            if (el) itemRefs.current.set(item.id, el);
            else itemRefs.current.delete(item.id);
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
    </>,
    containerEl,
  );
}

/**
 * 3D overlay wrapper. Creates a DOM container for overlay items,
 * then renders the projection logic inside the Three.js context.
 */
export function CanvasOverlay3DContainer({ children }: { children?: React.ReactNode }) {
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

export { CanvasOverlay3DInner };
