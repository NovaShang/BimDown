import { useRef, useCallback } from 'react';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { ProcessedLayer } from '../state/editorTypes.ts';

interface MinimapProps {
  layers: ProcessedLayer[];
  viewBox: { x: number; y: number; w: number; h: number };
  gridSvg?: string;
}

const MINIMAP_W = 180;
const MINIMAP_H = 120;

export default function Minimap({ layers, viewBox, gridSvg }: MinimapProps) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const ref = useRef<HTMLDivElement>(null);

  const { transform } = state;

  // Calculate viewport rect in SVG coordinates
  // The main canvas applies CSS transform: translate(tx, ty) scale(s)
  // and uses the viewBox directly. The visible area in SVG coords is:
  const canvasEl = document.querySelector('.canvas') as HTMLElement | null;
  const cw = canvasEl?.clientWidth ?? 800;
  const ch = canvasEl?.clientHeight ?? 600;

  // Visible SVG region accounting for pan/zoom
  const visX = viewBox.x - (transform.x / transform.scale) * (viewBox.w / cw);
  const visY = viewBox.y - (transform.y / transform.scale) * (viewBox.h / ch);
  const visW = viewBox.w / transform.scale;
  const visH = viewBox.h / transform.scale;

  // Map SVG coords to minimap pixel coords
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

    // Click position in minimap (0..MINIMAP_W, 0..MINIMAP_H)
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Convert to SVG coordinates (center of viewport at click point)
    const targetSvgX = viewBox.x + (mx / MINIMAP_W) * viewBox.w;
    const targetSvgY = viewBox.y + (my / MINIMAP_H) * viewBox.h;

    // Calculate new transform to center this SVG point
    const newX = (cw / 2) - ((targetSvgX - viewBox.x) / viewBox.w) * cw * transform.scale;
    const newY = (ch / 2) - ((targetSvgY - viewBox.y) / viewBox.h) * ch * transform.scale;

    dispatch({
      type: 'SET_TRANSFORM',
      transform: { ...transform, x: newX, y: newY },
    });
  }, [viewBox, transform, cw, ch, dispatch]);

  const vb = `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`;

  return (
    <div className="minimap" ref={ref} onClick={handleClick}>
      <svg
        className="minimap-svg"
        viewBox={vb}
        width={MINIMAP_W}
        height={MINIMAP_H}
      >
        {/* Grid (simplified) */}
        {gridSvg && (
          <g opacity="0.3" dangerouslySetInnerHTML={{ __html: gridSvg }} />
        )}
        {/* Layers */}
        {layers.map(layer => (
          <g
            key={layer.key}
            opacity="0.6"
            dangerouslySetInnerHTML={{ __html: layer.html }}
          />
        ))}
      </svg>
      {/* Viewport indicator */}
      <div
        className="minimap-viewport"
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
