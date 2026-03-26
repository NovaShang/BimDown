import { memo, useMemo } from 'react';
import { type BufferGeometry, type MeshPhysicalMaterial } from 'three';
import type { CanonicalElement } from '../../model/elements.ts';
import { useSelectionState } from '../../state/EditorContext.tsx';
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

/** Individual mesh — only re-renders when its highlighted state or geometry changes. */
const PolygonMesh = memo(function PolygonMesh({
  id, geometry, material, ghost, highlighted,
}: PolygonMeshData & { ghost?: boolean; highlighted: boolean }) {
  return (
    <mesh
      geometry={geometry}
      material={highlighted ? undefined : material}
      castShadow={!ghost}
      receiveShadow
      renderOrder={ghost ? -1 : 0}
      userData={{ elementId: id }}
      {...(ghost ? { raycast: () => {} } : {})}
    >
      {highlighted && (
        <meshStandardMaterial attach="material" color="#06b6d4"
          transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
      )}
    </mesh>
  );
});

export default function PolygonExtrusions({ elements, tableName, levelElevation, levelElevations, ghost }: PolygonExtrusionsProps) {
  const { selectedIds, hoveredId } = useSelectionState();

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
      {meshes.map(({ id, geometry, material }) => (
        <PolygonMesh
          key={id}
          id={id}
          geometry={geometry}
          material={material}
          ghost={ghost}
          highlighted={!ghost && (selectedIds.has(id) || hoveredId === id)}
        />
      ))}
    </group>
  );
}
