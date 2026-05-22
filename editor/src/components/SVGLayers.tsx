import React from 'react';
import type { ProcessedLayer } from '../state/editorTypes.ts';
import { ElementNode } from './ElementNode.tsx';

interface SVGLayersProps {
  layers: ProcessedLayer[];
  activeFilter: string | null;
  activeDiscipline: string | null;
}

/**
 * SVG layers: one <g> per ProcessedLayer, rendered in layer order. Each
 * element inside dispatches to its ElementModule via ElementNode.
 *
 * Wall outlines and space labels are now produced inside the respective
 * element modules' draw2D — no separate overlay layer anymore.
 */
const SVGLayers = React.memo(function SVGLayers({ layers, activeFilter, activeDiscipline }: SVGLayersProps) {
  return (
    <>
      {layers.map(layer => {
        const isBackground = (layer.discipline === 'architecture' && activeDiscipline !== 'architecture')
          || (layer.discipline === 'reference' && activeDiscipline !== 'reference');
        const layerStyle = isBackground ? { pointerEvents: 'none' as const, opacity: 0.35 } : undefined;
        const className = `data-layer ${activeFilter && layer.tableName !== activeFilter ? 'dimmed' : ''} ${isBackground ? 'background-layer' : ''}`;
        return (
          <g key={layer.key} className={className} data-layer={layer.key} style={layerStyle}>
            {layer.elements.map(el => (
              <ElementNode key={el.id} element={el} />
            ))}
          </g>
        );
      })}
    </>
  );
});

export default SVGLayers;
