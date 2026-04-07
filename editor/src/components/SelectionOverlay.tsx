import React from 'react';
import type { DocumentState } from '../model/document.ts';
import type { ProjectData } from '../types.ts';
import type { CanonicalElement, LineElement, SpatialLineElement } from '../model/elements.ts';
import { toElementId } from '../model/ids.ts';
import { parseLayer } from '../model/parse.ts';

interface SelectionOverlayProps {
  document: DocumentState | null;
  project: ProjectData | null;
  selectedIds: Set<string>;
  scale: number;
}

export default React.memo(function SelectionOverlay({ document, project, selectedIds, scale }: SelectionOverlayProps) {
  if (selectedIds.size === 0) return null;

  const selectedElements: CanonicalElement[] = [];
  for (const sid of selectedIds) {
    if (sid.startsWith('global:') && project) {
      // Look up in globalLayers
      const rawId = sid.slice('global:'.length);
      for (const gl of project.globalLayers) {
        const parsed = parseLayer(gl);
        const el = parsed.find(e => e.id === rawId);
        if (el) { selectedElements.push(el); break; }
      }
    } else if (document) {
      const el = document.elements.get(toElementId(sid));
      if (el) selectedElements.push(el);
    }
  }

  if (selectedElements.length === 0) return null;

  return (
    <g className="selection-overlay" transform="scale(1,-1)">
      {selectedElements.map((el) => {
        if (el.geometry === 'line' || el.geometry === 'spatial_line') {
          const lineEl = el as LineElement | SpatialLineElement;
          const arcData = lineEl.arc;
          if (arcData) {
            const r = (n: number) => Number(n.toFixed(3));
            const d = `M ${r(el.start.x)},${r(el.start.y)} A ${r(arcData.rx)},${r(arcData.ry)} ${r(arcData.rotation)} ${arcData.largeArc ? 1 : 0} ${arcData.sweep ? 1 : 0} ${r(el.end.x)},${r(el.end.y)}`;
            return (
              <path key={el.id} d={d} fill="none" stroke="#06b6d4"
                strokeWidth={0.24 / scale} opacity="0.6" strokeLinecap="round" pointerEvents="none" />
            );
          }
          return (
            <line key={el.id} x1={el.start.x} y1={el.start.y} x2={el.end.x} y2={el.end.y}
              stroke="#06b6d4" strokeWidth={0.24 / scale} opacity="0.6" strokeLinecap="round" pointerEvents="none" />
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
