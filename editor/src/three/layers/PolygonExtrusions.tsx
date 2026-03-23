import { useMemo } from 'react';
import { type BufferGeometry, type MeshPhysicalMaterial } from 'three';
import type { CanonicalElement } from '../../model/elements.ts';
import { useEditorState } from '../../state/EditorContext.tsx';
import { elementTo3DParams } from '../utils/elementTo3D.ts';
import { createExtrudeGeometry } from '../utils/extrudePolygon.ts';
import { resolveBimMaterial, getBimMaterial, getGhostMaterial } from '../utils/bimMaterials.ts';

interface PolygonExtrusionsProps {
  elements: CanonicalElement[];
  tableName: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}

interface PolygonMeshData {
  id: string;
  geometry: BufferGeometry;
  material: MeshPhysicalMaterial;
}

export default function PolygonExtrusions({ elements, tableName, levelElevation, levelElevations, ghost }: PolygonExtrusionsProps) {
  const { selectedIds, hoveredId } = useEditorState();

  const meshes = useMemo(() => {
    const result: PolygonMeshData[] = [];
    for (const el of elements) {
      const params = elementTo3DParams(el, levelElevation, levelElevations);
      if (params?.kind === 'extrude') {
        const geo = createExtrudeGeometry(params);
        if (geo) {
          const bimMat = resolveBimMaterial(el.attrs.material, tableName);
          const mat = ghost ? getGhostMaterial(bimMat) : getBimMaterial(bimMat);
          result.push({ id: el.id, geometry: geo, material: mat });
        }
      }
    }
    return result;
  }, [elements, tableName, levelElevation, levelElevations, ghost]);

  if (meshes.length === 0) return null;

  return (
    <group>
      {meshes.map(({ id, geometry, material }) => {
        const isHighlighted = !ghost && (selectedIds.has(id) || hoveredId === id);
        return (
          <group key={id}>
            <mesh
              geometry={geometry}
              material={material}
              castShadow={!ghost}
              receiveShadow
              renderOrder={ghost ? -1 : 0}
              userData={{ elementId: id }}
              {...(ghost ? { raycast: () => {} } : {})}
            >
              {isHighlighted && (
                <meshStandardMaterial attach="material" color="#0d99ff"
                  transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
              )}
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
