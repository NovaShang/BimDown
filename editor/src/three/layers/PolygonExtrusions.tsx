import { memo, useMemo } from 'react';
import { Shape, ExtrudeGeometry, type BufferGeometry, type MeshPhysicalMaterial } from 'three';
import { SUBTRACTION, Evaluator, Brush } from 'three-bvh-csg';
import type { CanonicalElement, PolygonElement } from '../../model/elements.ts';
import { useSelectionState } from '../../state/EditorContext.tsx';
import { elementTo3DParams } from '../utils/elementTo3D.ts';
import { createExtrudeGeometry } from '../utils/extrudePolygon.ts';
import { resolveBimMaterial, getBimMaterial, getGhostMaterial } from '../utils/bimMaterials.ts';

const csgEvaluator = new Evaluator();

interface PolygonExtrusionsProps {
  elements: CanonicalElement[];
  tableName: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
  allElements?: Map<string, CanonicalElement>;
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

/** Build a map of slabId → opening polygon elements that cut into it.
 *  Handles prefixed IDs (e.g., "level1:sl1" in 3D) by matching against
 *  both the full slab ID and the un-prefixed host_id from CSV. */
function buildSlabOpeningsMap(
  allElements: Map<string, CanonicalElement> | undefined,
  slabIds: Set<string>,
): Map<string, PolygonElement[]> {
  const map = new Map<string, PolygonElement[]>();
  if (!allElements || slabIds.size === 0) return map;

  // Build reverse lookup: un-prefixed ID → prefixed slab ID
  const unprefixedToSlab = new Map<string, string>();
  for (const slabId of slabIds) {
    unprefixedToSlab.set(slabId, slabId);
    // Handle "levelId:elementId" prefix format
    const colonIdx = slabId.indexOf(':');
    if (colonIdx >= 0) {
      unprefixedToSlab.set(slabId.substring(colonIdx + 1), slabId);
    }
  }

  for (const el of allElements.values()) {
    if (el.tableName !== 'opening' || el.geometry !== 'polygon') continue;
    const hostId = el.hostId || el.attrs.host_id;
    if (!hostId) continue;
    const matchedSlabId = unprefixedToSlab.get(hostId);
    if (!matchedSlabId) continue;
    const list = map.get(matchedSlabId) ?? [];
    list.push(el as PolygonElement);
    map.set(matchedSlabId, list);
  }

  return map;
}

/** Subtract opening polygons from slab geometry using CSG. */
function subtractSlabOpenings(
  slabGeo: BufferGeometry,
  openings: PolygonElement[],
  baseY: number,
  height: number,
): BufferGeometry {
  let slabBrush = new Brush(slabGeo);

  for (const op of openings) {
    if (op.vertices.length < 3) continue;

    const shape = new Shape();
    shape.moveTo(op.vertices[0].x, op.vertices[0].y);
    for (let i = 1; i < op.vertices.length; i++) {
      shape.lineTo(op.vertices[i].x, op.vertices[i].y);
    }
    shape.closePath();

    // Extrude the opening shape through the full slab thickness (with margin)
    const cutGeo = new ExtrudeGeometry(shape, { depth: height * 2, bevelEnabled: false });
    cutGeo.rotateX(-Math.PI / 2);
    cutGeo.translate(0, baseY - height * 0.5, 0);

    const cutBrush = new Brush(cutGeo);

    try {
      const result = csgEvaluator.evaluate(slabBrush, cutBrush, SUBTRACTION);
      slabBrush = result;
    } catch {
      // CSG can fail on degenerate geometry — skip this opening
    }

    cutGeo.dispose();
  }

  return slabBrush.geometry;
}

export default function PolygonExtrusions({ elements, tableName, levelElevation, levelElevations, ghost, allElements }: PolygonExtrusionsProps) {
  const { selectedIds, hoveredId } = useSelectionState();

  const isSlab = tableName === 'slab' || tableName === 'structure_slab';
  const slabIds = useMemo(() => {
    if (!isSlab) return new Set<string>();
    return new Set(elements.map(el => el.id));
  }, [elements, isSlab]);
  const slabOpeningsMap = useMemo(
    () => isSlab ? buildSlabOpeningsMap(allElements, slabIds) : new Map<string, PolygonElement[]>(),
    [allElements, slabIds, isSlab],
  );

  const meshes = useMemo(() => {
    const result: PolygonMeshData[] = [];
    for (const el of elements) {
      const params = elementTo3DParams(el, levelElevation, levelElevations);
      if (params?.kind === 'extrude') {
        let geo = createExtrudeGeometry(params);
        if (geo) {
          // Subtract slab openings if this is a slab element
          const openings = slabOpeningsMap.get(el.id);
          if (openings && openings.length > 0 && !ghost) {
            geo = subtractSlabOpenings(geo, openings, params.baseY, params.height);
          }

          const bimMat = resolveBimMaterial(el.attrs.material, tableName);
          const mat = ghost ? getGhostMaterial(bimMat) : getBimMaterial(bimMat);
          result.push({ id: el.id, geometry: geo, material: mat });
        }
      }
    }
    return result;
  }, [elements, tableName, levelElevation, levelElevations, ghost, slabOpeningsMap]);

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
