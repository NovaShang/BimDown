import React from 'react';
import type { ProcessedLayer } from '../state/editorTypes.ts';
import { ElementNode } from './ElementNode.tsx';
import { WallOutlines } from './WallOutlines.tsx';
import { renderSpaceLabels } from '../renderers/spaceRenderer.tsx';

interface SVGLayersProps {
  layers: ProcessedLayer[];
  activeFilter: string | null;
  activeDiscipline: string | null;
}

const BELOW_OUTLINE = new Set([
  'wall', 'structure_wall', 'curtain_wall',
  'duct', 'pipe', 'conduit', 'cable_tray',
  'space', 'slab', 'structure_slab', 'stair',
]);

/**
 * The heavy SVG content: data layers, wall outlines, and space labels.
 * Wrapped in React.memo so it never re-renders during pan/zoom —
 * only when the actual layer data, filter, or discipline changes.
 */
const SVGLayers = React.memo(function SVGLayers({ layers, activeFilter, activeDiscipline }: SVGLayersProps) {
  const nodes: React.ReactNode[] = [];
  let outlineInserted = false;

  for (const layer of layers) {
    const isBackground = (layer.discipline === 'architecture' && activeDiscipline !== 'architecture')
      || (layer.discipline === 'reference' && activeDiscipline !== 'reference');
    const layerStyle = isBackground ? { pointerEvents: 'none' as const, opacity: 0.35 } : undefined;
    const className = `data-layer ${activeFilter && layer.tableName !== activeFilter ? 'dimmed' : ''} ${isBackground ? 'background-layer' : ''}`;
    const isBelowOutline = BELOW_OUTLINE.has(layer.tableName);

    if (!outlineInserted && !isBelowOutline) {
      nodes.push(<WallOutlines key="__wall_outlines__" layers={layers} />);
      outlineInserted = true;
    }

    nodes.push(
      <g key={layer.key} className={className} data-layer={layer.key} style={layerStyle}>
        {layer.elements.map(el => (
          <ElementNode key={el.id} element={el} />
        ))}
      </g>
    );
  }

  if (!outlineInserted) nodes.push(<WallOutlines key="__wall_outlines__" layers={layers} />);

  const spaceLabels = layers
    .filter(l => l.tableName === 'space')
    .flatMap(l => renderSpaceLabels(l.elements));

  return (
    <>
      {nodes}
      <g className="space-labels" transform="scale(1,-1)">
        {spaceLabels}
      </g>
    </>
  );
});

export default SVGLayers;
