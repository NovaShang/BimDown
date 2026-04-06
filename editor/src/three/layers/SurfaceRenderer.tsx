import { memo, useMemo } from 'react';
import { EdgesGeometry, LineBasicMaterial, type BufferGeometry, type MeshPhysicalMaterial } from 'three';
import type { LineElement, CanonicalElement } from '../../model/elements.ts';
import { useSelectionState } from '../../state/EditorContext.tsx';
import type { Renderer3DProps } from '../renderers/index.ts';
import { buildPrimitives } from '../builders/index.ts';
import { generateSurfaceGeometry } from '../resolve/generateGeometry.ts';
import { resolvePrimitives } from '../resolve/pipeline.ts';
import { getBimMaterial, getGhostMaterial } from '../utils/bimMaterials.ts';
import type { SurfacePrimitive } from '../primitives/types.ts';

const WIRE_MATERIAL = new LineBasicMaterial({ color: '#7eb8da', transparent: true, opacity: 0.6 });
const WIRE_GHOST_MATERIAL = new LineBasicMaterial({ color: '#7eb8da', transparent: true, opacity: 0.15 });
const WIRE_HIGHLIGHT_MATERIAL = new LineBasicMaterial({ color: '#06b6d4', opacity: 1 });

interface SurfaceMeshData {
  id: string;
  geometry: BufferGeometry;
  material: MeshPhysicalMaterial;
}

interface SurfaceWireData {
  id: string;
  edgeGeometry: EdgesGeometry;
}

/** Individual mesh — only re-renders when its highlighted state or geometry changes. */
const SurfaceMesh = memo(function SurfaceMesh({
  id, geometry, material, ghost, highlighted,
}: SurfaceMeshData & { ghost?: boolean; highlighted: boolean }) {
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

const SurfaceWire = memo(function SurfaceWire({
  id, edgeGeometry, ghost, highlighted,
}: SurfaceWireData & { ghost?: boolean; highlighted: boolean }) {
  const baseMaterial = ghost ? WIRE_GHOST_MATERIAL : WIRE_MATERIAL;
  return (
    <lineSegments
      geometry={edgeGeometry}
      material={highlighted ? WIRE_HIGHLIGHT_MATERIAL : baseMaterial}
      userData={{ elementId: id }}
      {...(ghost ? { raycast: () => {} } : {})}
    />
  );
});

/**
 * Unified renderer for SurfacePrimitive-producing element types.
 * Dispatches element → builder → resolve pipeline → React mesh/wireframe.
 */
export default function SurfaceRenderer({
  elements, levelElevation, levelElevations, ghost, allElements,
}: Renderer3DProps) {
  const { selectedIds, hoveredId } = useSelectionState();

  const { meshes, wires } = useMemo(() => {
    const meshes: SurfaceMeshData[] = [];
    const wires: SurfaceWireData[] = [];

    // Collect wall line elements from allElements (needed for hosted-element spatial matching).
    const wallsOnLevel: LineElement[] = [];
    if (allElements) {
      for (const el of allElements.values()) {
        if ((el.tableName === 'wall' || el.tableName === 'structure_wall' || el.tableName === 'curtain_wall')
            && (el.geometry === 'line' || el.geometry === 'spatial_line')) {
          wallsOnLevel.push(el as LineElement);
        }
      }
    }

    const ctx = { levelElevation, levelElevations, allElements, wallsOnLevel };

    // Build primitives for all elements
    const built: SurfacePrimitive[] = [];
    for (const el of elements) {
      for (const prim of buildPrimitives(el, ctx)) {
        if (prim.kind === 'surface') built.push(prim);
      }
    }

    // Trim sources: build roof primitives from allElements when rendering walls.
    // Roofs live in different renderer calls; this pulls them in just for trim.
    const trimSources: SurfacePrimitive[] = [];
    const isWallCall = elements.some(el => el.tableName === 'wall' || el.tableName === 'structure_wall');
    if (isWallCall && allElements) {
      const roofElements: CanonicalElement[] = [];
      for (const el of allElements.values()) {
        if (el.tableName === 'roof') roofElements.push(el);
      }
      for (const el of roofElements) {
        for (const prim of buildPrimitives(el, ctx)) {
          if (prim.kind === 'surface') trimSources.push(prim);
        }
      }
    }

    // Resolve (miter, trim, etc.)
    const resolved = resolvePrimitives(built, { trimSources });

    // Generate geometry + render data
    for (const prim of resolved) {
      if (prim.kind !== 'surface') continue;
      // Skip CSG openings in ghost mode for performance
      const primForGen = ghost ? { ...prim, openings: undefined } : prim;
      const geo = generateSurfaceGeometry(primForGen);
      if (!geo) continue;

      if (prim.wireframe) {
        const edges = new EdgesGeometry(geo, 15);
        geo.dispose();
        wires.push({ id: prim.elementId, edgeGeometry: edges });
      } else {
        const mat = ghost ? getGhostMaterial(prim.material) : getBimMaterial(prim.material);
        meshes.push({ id: prim.elementId, geometry: geo, material: mat });
      }
    }
    return { meshes, wires };
  }, [elements, levelElevation, levelElevations, ghost, allElements]);

  if (meshes.length === 0 && wires.length === 0) return null;

  return (
    <group>
      {meshes.map(({ id, geometry, material }) => (
        <SurfaceMesh
          key={id}
          id={id}
          geometry={geometry}
          material={material}
          ghost={ghost}
          highlighted={!ghost && (selectedIds.has(id) || hoveredId === id)}
        />
      ))}
      {wires.map(({ id, edgeGeometry }) => (
        <SurfaceWire
          key={id}
          id={id}
          edgeGeometry={edgeGeometry}
          ghost={ghost}
          highlighted={!ghost && (selectedIds.has(id) || hoveredId === id)}
        />
      ))}
    </group>
  );
}
