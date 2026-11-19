import { useRef, useEffect, useCallback } from 'react';
import type { OverlayItem, OverlayAnchor } from '../hooks/useOverlayItems.ts';

function anchorTranslate(anchor: OverlayAnchor | undefined): string {
  const tx = !anchor || anchor.includes('left') ? '0%'
    : anchor.includes('right') ? '-100%' : '-50%';
  const ty = !anchor || anchor.includes('top') ? '0%'
    : anchor.includes('bottom') ? '-100%' : '-50%';
  return `translate(${tx}, ${ty})`;
}

interface CanvasOverlayProps {
  items: OverlayItem[];
  svgRef: React.RefObject<SVGSVGElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  subscribeTransform: (cb: () => void) => () => void;
}

/**
 * Renders HTML overlay items anchored to model-space positions on the 2D canvas.
 * Positions are updated via direct DOM manipulation on every transform change
 * (no React re-render during pan/zoom).
 */
export default function CanvasOverlay({ items, svgRef, containerRef, subscribeTransform }: CanvasOverlayProps) {
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const syncPositions = useCallback(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;

    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const containerRect = container.getBoundingClientRect();

    for (const item of items) {
      const el = itemRefs.current.get(item.id);
      if (!el) continue;

      // Model → screen: model y is down, SVG y is up (negated)
      const mx = item.position.x;
      const my = -item.position.y; // negate for SVG coordinate system
      const screenX = mx * ctm.a + my * ctm.c + ctm.e - containerRect.left + (item.offset?.x ?? 0);
      const screenY = mx * ctm.b + my * ctm.d + ctm.f - containerRect.top + (item.offset?.y ?? 0);

      el.style.transform = `translate(${screenX}px, ${screenY}px) ${anchorTranslate(item.anchor)}`;
    }
  }, [items, svgRef, containerRef]);

  // Sync on every transform change (pan/zoom)
  useEffect(() => {
    syncPositions();
    return subscribeTransform(syncPositions);
  }, [syncPositions, subscribeTransform]);

  // Also sync after React renders (items changed)
  useEffect(() => {
    syncPositions();
  }, [items, syncPositions]);

  if (items.length === 0) return null;

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
    </div>
  );
}
