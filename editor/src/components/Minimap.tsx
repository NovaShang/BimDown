import { useRef, useCallback } from 'react';
import type { ProcessedLayer, ViewTransform } from '../state/editorTypes.ts';
import { ElementNode } from './ElementNode.tsx';

interface MinimapProps {
  layers: ProcessedLayer[];
  viewBox: { x: number; y: number; w: number; h: number };
  transform: ViewTransform;
  setTransform: React.Dispatch<React.SetStateAction<ViewTransform>>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const MINIMAP_W = 180;
const MINIMAP_H = 120;

export default function Minimap({ layers, viewBox, transform, setTransform, containerRef }: MinimapProps) {
  const ref = useRef<HTMLDivElement>(null);

  const cw = containerRef.current?.clientWidth ?? 800;
  const ch = containerRef.current?.clientHeight ?? 600;

  const visX = viewBox.x - (transform.x / transform.scale) * (viewBox.w / cw);
  const visY = viewBox.y - (transform.y / transform.scale) * (viewBox.h / ch);
  const visW = viewBox.w / transform.scale;
  const visH = viewBox.h / transform.scale;

  const mapX = (svgX: number) => ((svgX - viewBox.x) / viewBox.w) * MINIMAP_W;
  const mapY = (svgY: number) => ((svgY - viewBox.y) / viewBox.h) * MINIMAP_H;
  const mapW = (svgW: number) => (svgW / viewBox.w) * MINIMAP_W;
  const mapH = (svgH: number) => (svgH / viewBox.h) * MINIMAP_H;

  const vpX = mapX(visX);
  const vpY = mapY(visY);
  const vpW = mapW(visW);
  const vpH = mapH(visH);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;

    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const targetSvgX = viewBox.x + (mx / MINIMAP_W) * viewBox.w;
    const targetSvgY = viewBox.y + (my / MINIMAP_H) * viewBox.h;

    const newX = (cw / 2) - ((targetSvgX - viewBox.x) / viewBox.w) * cw * transform.scale;
    const newY = (ch / 2) - ((targetSvgY - viewBox.y) / viewBox.h) * ch * transform.scale;

    setTransform(prev => ({ ...prev, x: newX, y: newY }));
  }, [viewBox, transform, cw, ch, setTransform]);

  const vb = `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`;

  return (
    <div
      ref={ref}
      onClick={handleClick}
      className="glass-panel absolute bottom-3 left-[230px] z-20 h-[120px] w-[180px] cursor-pointer overflow-hidden rounded-lg border border-[#2a2a2a] opacity-85 transition-opacity hover:opacity-100"
    >
      <svg
        className="block size-full"
        viewBox={vb}
        width={MINIMAP_W}
        height={MINIMAP_H}
      >
        {layers.map(layer => (
          <g key={layer.key} opacity="0.6">
            {layer.elements.map(el => (
              <ElementNode key={el.id} element={el} />
            ))}
          </g>
        ))}
      </svg>
      <div
        className="pointer-events-none absolute rounded-[1px] border-[1.5px] border-[var(--color-accent)] bg-[rgba(13,153,255,0.08)]"
        style={{
          left: Math.max(0, vpX),
          top: Math.max(0, vpY),
          width: Math.min(vpW, MINIMAP_W),
          height: Math.min(vpH, MINIMAP_H),
        }}
      />
    </div>
  );
}
