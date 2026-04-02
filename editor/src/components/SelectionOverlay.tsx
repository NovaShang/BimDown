import React from 'react';
import type { DocumentState } from '../model/document.ts';
import type { CanonicalElement } from '../model/elements.ts';
import { toElementId } from '../model/ids.ts';

interface SelectionOverlayProps {
  document: DocumentState | null;
  selectedIds: Set<string>;
  scale: number;
}

export default React.memo(function SelectionOverlay({ document, selectedIds, scale }: SelectionOverlayProps) {
  if (!document || selectedIds.size === 0) return null;

  const selectedElements: CanonicalElement[] = [];
  for (const sid of selectedIds) {
    const el = document.elements.get(toElementId(sid));
    if (el) selectedElements.push(el);
  }

  if (selectedElements.length === 0) return null;

  return (
    <g className="selection-overlay" transform="scale(1,-1)">
      {selectedElements.map((el) => {
        if (el.geometry === 'line' || el.geometry === 'spatial_line') {
          return (
            <line
              key={el.id}
              x1={el.start.x}
              y1={el.start.y}
              x2={el.end.x}
              y2={el.end.y}
              stroke="#06b6d4"
              strokeWidth={0.24 / scale}
              opacity="0.6"
              strokeLinecap="round"
              pointerEvents="none"
            />
          );
        }
        
        if (el.geometry === 'polygon') {
          const pointsStr = el.vertices.map(v => `${v.x},${v.y}`).join(' ');
          return (
            <polygon
              key={el.id}
              points={pointsStr}
              fill="rgba(13, 153, 255, 0.1)"
              stroke="#06b6d4"
              strokeWidth={0.15 / scale}
              strokeLinejoin="round"
              pointerEvents="none"
            />
          );
        }
        
        return null;
      })}
    </g>
  );
});
