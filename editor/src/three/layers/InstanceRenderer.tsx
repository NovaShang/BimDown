import { useRef, useMemo, useEffect } from 'react';
import { InstancedMesh, ExtrudeGeometry, BoxGeometry, Object3D, Color, type BufferGeometry } from 'three';
import { useSelectionState } from '../../state/EditorContext.tsx';
import type { Renderer3DProps } from '../renderers/index.ts';
import { buildPrimitives } from '../builders/index.ts';
import { createProfile } from '../primitives/profiles.ts';
import { profileKey } from '../primitives/profileKey.ts';
import { getBimMaterial, getGhostMaterial, type BimMaterial } from '../utils/bimMaterials.ts';
import type { InstancePrimitive } from '../primitives/types.ts';

const tempObject = new Object3D();
const HIGHLIGHT_COLOR = new Color('#06b6d4');

const SHADOW_CAST_TABLES = new Set(['column', 'structure_column']);

interface InstanceGroup {
  key: string;
  material: BimMaterial;
  geometry: BufferGeometry;
  instances: InstancePrimitive[];
  tableName: string;
}

/**
 * Unified renderer for InstancePrimitive-producing element types (columns, equipment, etc.).
 * Groups primitives by (source signature, material), creates one geometry per group,
 * and instances them via InstancedMesh with per-instance transforms.
 */
export default function InstanceRenderer({
  elements, levelElevation, levelElevations, ghost, allElements,
}: Renderer3DProps) {
  const groups = useMemo(() => {
    const ctx = { levelElevation, levelElevations, allElements };
    const byKey = new Map<string, InstanceGroup>();
    for (const el of elements) {
      for (const prim of buildPrimitives(el, ctx)) {
        if (prim.kind !== 'instance') continue;
        const key = `${sourceKey(prim)}|${prim.material}|${prim.tableName}`;
        let group = byKey.get(key);
        if (!group) {
          const geo = createInstanceGeometry(prim);
          if (!geo) continue;
          group = {
            key,
            material: prim.material,
            geometry: geo,
            instances: [],
            tableName: prim.tableName,
          };
          byKey.set(key, group);
        }
        group.instances.push(prim);
      }
    }
    return [...byKey.values()];
  }, [elements, levelElevation, levelElevations, allElements]);

  if (groups.length === 0) return null;

  return (
    <group>
      {groups.map(g => (
        <InstanceGroupMesh key={g.key} group={g} ghost={ghost} />
      ))}
    </group>
  );
}

function sourceKey(prim: InstancePrimitive): string {
  const s = prim.source;
  switch (s.type) {
    case 'profile':  return `profile:${profileKey(s.profile)}:${s.height}`;
    case 'box':      return 'box';
    case 'mesh':     return `mesh:${s.url}`;
    case 'geometry': return `geometry:${s.geometry.uuid}`;
  }
}

/**
 * Build the per-group geometry from one primitive's source (all in the group share source).
 * For 'profile': extrudes shape vertically by height. Geometry base at origin, top at +height.
 * For 'box': unit cube centered at origin.
 * 'mesh' and 'geometry' returned by caller with the source geometry.
 */
function createInstanceGeometry(prim: InstancePrimitive): BufferGeometry | null {
  const s = prim.source;
  switch (s.type) {
    case 'profile': {
      const shape = createProfile(s.profile);
      const geo = new ExtrudeGeometry(shape, { depth: s.height, bevelEnabled: false });
      // Profile is in XY plane, extruded to +Z. Rotate so profile cross-section is horizontal (XZ plane)
      // and extrude goes vertically (+Y).
      geo.rotateX(-Math.PI / 2);
      return geo;
    }
    case 'box':
      return new BoxGeometry(1, 1, 1);
    case 'geometry':
      return s.geometry;
    case 'mesh':
      // Loaded meshes handled by MeshInstances / Phase 6
      return null;
  }
}

function InstanceGroupMesh({ group, ghost }: { group: InstanceGroup; ghost?: boolean }) {
  const meshRef = useRef<InstancedMesh>(null);
  const { selectedIds, hoveredId } = useSelectionState();
  const prevHighlightRef = useRef<boolean[]>([]);

  const material = useMemo(
    () => ghost ? getGhostMaterial(group.material) : getBimMaterial(group.material),
    [ghost, group.material],
  );

  const indexToId = useMemo(
    () => group.instances.map(p => p.elementId),
    [group.instances],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    for (let i = 0; i < group.instances.length; i++) {
      const prim = group.instances[i];
      tempObject.position.set(prim.position.x, prim.position.y, prim.position.z);
      tempObject.rotation.set(prim.rotation.x, prim.rotation.y, prim.rotation.z);
      tempObject.scale.set(prim.scale.x, prim.scale.y, prim.scale.z);
      tempObject.updateMatrix();
      mesh.setMatrixAt(i, tempObject.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    prevHighlightRef.current = [];
  }, [group.instances]);

  useEffect(() => {
    if (ghost) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    const baseColor = new Color(material.color);
    const prev = prevHighlightRef.current;
    let anyChanged = false;

    for (let i = 0; i < indexToId.length; i++) {
      const id = indexToId[i];
      const isHighlighted = selectedIds.has(id) || hoveredId === id;
      if (prev.length === indexToId.length && prev[i] === isHighlighted) continue;
      mesh.setColorAt(i, isHighlighted ? HIGHLIGHT_COLOR : baseColor);
      anyChanged = true;
    }
    if (anyChanged && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    const next = new Array<boolean>(indexToId.length);
    for (let i = 0; i < indexToId.length; i++) {
      const id = indexToId[i];
      next[i] = selectedIds.has(id) || hoveredId === id;
    }
    prevHighlightRef.current = next;
  }, [ghost, selectedIds, hoveredId, indexToId, material.color]);

  const shouldCastShadow = !ghost && SHADOW_CAST_TABLES.has(group.tableName);

  return (
    <instancedMesh
      ref={meshRef}
      args={[group.geometry, material, group.instances.length]}
      frustumCulled
      castShadow={shouldCastShadow}
      receiveShadow={!ghost}
      renderOrder={ghost ? -1 : 0}
      userData={{ indexToId }}
      {...(ghost ? { raycast: () => {} } : {})}
    />
  );
}
