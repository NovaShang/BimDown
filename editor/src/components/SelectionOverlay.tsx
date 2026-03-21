import { useEffect, useState, type RefObject } from 'react';

interface SelectionOverlayProps {
  svgRef: RefObject<SVGSVGElement | null>;
  selectedIds: Set<string>;
}

interface SelectionRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function SelectionOverlay({ svgRef, selectedIds }: SelectionOverlayProps) {
  const [rects, setRects] = useState<SelectionRect[]>([]);

  useEffect(() => {
    if (selectedIds.size === 0 || !svgRef.current) {
      setRects([]);
      return;
    }

    const svg = svgRef.current;
    const result: SelectionRect[] = [];
    const processed = new Set<string>();

    for (const id of selectedIds) {
      if (processed.has(id)) continue;
      processed.add(id);

      const elements = svg.querySelectorAll(`[data-id="${id}"]`);
      if (elements.length === 0) continue;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      for (const el of elements) {
        try {
          const bbox = (el as SVGGraphicsElement).getBBox();
          minX = Math.min(minX, bbox.x);
          minY = Math.min(minY, bbox.y);
          maxX = Math.max(maxX, bbox.x + bbox.width);
          maxY = Math.max(maxY, bbox.y + bbox.height);
        } catch {
          // getBBox can throw
        }
      }

      if (minX < Infinity) {
        const pad = 0.05;
        result.push({
          id,
          x: minX - pad,
          y: minY - pad,
          w: maxX - minX + pad * 2,
          h: maxY - minY + pad * 2,
        });
      }
    }

    setRects(result);
  }, [selectedIds, svgRef]);

  if (rects.length === 0) return null;

  return (
    <g className="selection-overlay" transform="scale(1,-1)">
      {rects.map(r => (
        <rect
          key={r.id}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          fill="rgba(13, 153, 255, 0.06)"
          stroke="#0d99ff"
          strokeWidth="0.03"
          rx="0.02"
          pointerEvents="none"
        />
      ))}
    </g>
  );
}
