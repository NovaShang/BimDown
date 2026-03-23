import { useMemo } from 'react';
import { EdgesGeometry, LineBasicMaterial } from 'three';
import type { CanonicalElement } from '../../model/elements.ts';
import { useEditorState } from '../../state/EditorContext.tsx';
import { elementTo3DParams } from '../utils/elementTo3D.ts';
import { createExtrudeGeometry } from '../utils/extrudePolygon.ts';

interface SpaceWireframesProps {
  elements: CanonicalElement[];
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}

const WIRE_MATERIAL = new LineBasicMaterial({ color: '#7eb8da', transparent: true, opacity: 0.6 });
const WIRE_GHOST_MATERIAL = new LineBasicMaterial({ color: '#7eb8da', transparent: true, opacity: 0.15 });
const WIRE_HIGHLIGHT_MATERIAL = new LineBasicMaterial({ color: '#0d99ff', opacity: 1 });

interface SpaceMeshData {
  id: string;
  edgeGeometry: EdgesGeometry;
}

export default function SpaceWireframes({ elements, levelElevation, levelElevations, ghost }: SpaceWireframesProps) {
  const { selectedIds, hoveredId } = useEditorState();

  const meshes = useMemo(() => {
    const result: SpaceMeshData[] = [];
    for (const el of elements) {
      const params = elementTo3DParams(el, levelElevation, levelElevations);
      if (params?.kind === 'extrude') {
        const geo = createExtrudeGeometry(params);
        if (geo) {
          const edges = new EdgesGeometry(geo, 15);
          geo.dispose();
          result.push({ id: el.id, edgeGeometry: edges });
        }
      }
    }
    return result;
  }, [elements, levelElevation, levelElevations]);

  if (meshes.length === 0) return null;

  const baseMaterial = ghost ? WIRE_GHOST_MATERIAL : WIRE_MATERIAL;

  return (
    <group>
      {meshes.map(({ id, edgeGeometry }) => {
        const isHighlighted = !ghost && (selectedIds.has(id) || hoveredId === id);
        return (
          <lineSegments
            key={id}
            geometry={edgeGeometry}
            material={isHighlighted ? WIRE_HIGHLIGHT_MATERIAL : baseMaterial}
            userData={{ elementId: id }}
            {...(ghost ? { raycast: () => {} } : {})}
          />
        );
      })}
    </group>
  );
}
