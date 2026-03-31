import React, { useRef, useCallback, useEffect } from 'react';
import type { ProcessedLayer, ViewTransform } from '../state/editorTypes.ts';
import type { TransformUpdater } from '../hooks/useCanvasTransform.ts';
import { ElementNode } from './ElementNode.tsx';

interface MinimapProps {
  layers: ProcessedLayer[];
  viewBox: { x: number; y: number; w: number; h: number };
  transformRef: React.RefObject<ViewTransform>;
  updateTransform: (updater: TransformUpdater) => void;
  subscribeTransform: (cb: () => void) => () => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const MINIMAP_W = 180;
const MINIMAP_H = 120;

export default function Minimap({ layers, viewBox, transformRef, updateTransform, subscribeTransform, containerRef }: MinimapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const rafId = useRef(0);

  const cw = containerRef.current?.clientWidth ?? 800;
  const ch = containerRef.current?.clientHeight ?? 600;

  // Update viewport indicator via direct DOM — no React re-render during pan/zoom
  const syncViewport = useCallback(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const t = transformRef.current;
    const visX = viewBox.x - (t.x / t.scale) * (viewBox.w / cw);
    const visY = viewBox.y - (t.y / t.scale) * (viewBox.h / ch);
    const visW = viewBox.w / t.scale;
    const visH = viewBox.h / t.scale;
    const vpX = ((visX - viewBox.x) / viewBox.w) * MINIMAP_W;
    const vpY = ((visY - viewBox.y) / viewBox.h) * MINIMAP_H;
    const vpW = (visW / viewBox.w) * MINIMAP_W;
    const vpH = (visH / viewBox.h) * MINIMAP_H;
    vp.style.left = `${Math.max(0, vpX)}px`;
    vp.style.top = `${Math.max(0, vpY)}px`;
    vp.style.width = `${Math.min(vpW, MINIMAP_W)}px`;
    vp.style.height = `${Math.min(vpH, MINIMAP_H)}px`;
  }, [viewBox, cw, ch, transformRef]);

  // Subscribe to transform changes and update viewport via RAF
  useEffect(() => {
    syncViewport(); // initial sync
    return subscribeTransform(() => {
      if (!rafId.current) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = 0;
          syncViewport();
        });
      }
    });
  }, [subscribeTransform, syncViewport]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const targetSvgX = viewBox.x + (mx / MINIMAP_W) * viewBox.w;
    const targetSvgY = viewBox.y + (my / MINIMAP_H) * viewBox.h;
    const scale = transformRef.current.scale;
    const newX = (cw / 2) - ((targetSvgX - viewBox.x) / viewBox.w) * cw * scale;
    const newY = (ch / 2) - ((targetSvgY - viewBox.y) / viewBox.h) * ch * scale;
    updateTransform(prev => ({ ...prev, x: newX, y: newY }));
  }, [viewBox, cw, ch, transformRef, updateTransform]);

  const vb = `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`;

  return (
    <div
      ref={ref}
      onClick={handleClick}
      className="glass-panel absolute bottom-3 left-[230px] z-20 h-[120px] w-[180px] cursor-pointer overflow-hidden rounded-lg border border-[var(--panel-border)] opacity-85 transition-opacity hover:opacity-100"
    >
      <MinimapContent layers={layers} viewBox={vb} />
      <div
        ref={vpRef}
        className="pointer-events-none absolute rounded-[1px] border-[1.5px] border-[var(--color-accent)] bg-[rgba(13,153,255,0.08)]"
      />
    </div>
  );
}

/** Memoized SVG content — only re-renders when layers change, not on every pan/zoom. */
const MinimapContent = React.memo(function MinimapContent({ layers, viewBox }: { layers: ProcessedLayer[]; viewBox: string }) {
  return (
    <svg className="block size-full" viewBox={viewBox} width={MINIMAP_W} height={MINIMAP_H}>
      {layers.map(layer => (
        <g key={layer.key} opacity="0.6">
          {layer.elements.map(el => (
            <ElementNode key={el.id} element={el} />
          ))}
        </g>
      ))}
    </svg>
  );
});
