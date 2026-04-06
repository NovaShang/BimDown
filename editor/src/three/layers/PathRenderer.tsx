import { useRef, useMemo, useEffect } from 'react';
import { InstancedMesh, ExtrudeGeometry, Object3D, Color, type BufferGeometry } from 'three';
import { useSelectionState } from '../../state/EditorContext.tsx';
import type { Renderer3DProps } from '../renderers/index.ts';
import { buildPrimitives } from '../builders/index.ts';
import { createProfile } from '../primitives/profiles.ts';
import { profileKey } from '../primitives/profileKey.ts';
import { getBimMaterial, getGhostMaterial, type BimMaterial } from '../utils/bimMaterials.ts';
import type { PathPrimitive } from '../primitives/types.ts';

const tempObject = new Object3D();
const HIGHLIGHT_COLOR = new Color('#06b6d4');

interface PathGroup {
  key: string;
  material: BimMaterial;
  geometry: BufferGeometry;
  instances: PathPrimitive[];
}

/**
 * Unified renderer for PathPrimitive-producing element types (beams, pipes, ducts, etc.).
 * Groups primitives by (profile, material), extrudes a unit-length profile per group,
 * and uses InstancedMesh with per-instance transforms (rotate + scale-to-length).
 */
export default function PathRenderer({
  elements, levelElevation, levelElevations, ghost, allElements,
}: Renderer3DProps) {
  const groups = useMemo(() => {
    const ctx = { levelElevation, levelElevations, allElements };
    const byKey = new Map<string, PathGroup>();
    for (const el of elements) {
      for (const prim of buildPrimitives(el, ctx)) {
        if (prim.kind !== 'path') continue;
        const key = `${profileKey(prim.profile)}|${prim.material}`;
        let group = byKey.get(key);
        if (!group) {
          // Unit-length extrusion: profile in XY, depth=1 along +Z, rotated so sweep is +X.
          const shape = createProfile(prim.profile);
          const geo = new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
          // rotateY(π/2) maps extrude +Z → +X; translate(-0.5) centers sweep on origin
          geo.rotateY(Math.PI / 2);
          geo.translate(-0.5, 0, 0);
          group = { key, material: prim.material, geometry: geo, instances: [] };
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
        <PathGroupMesh key={g.key} group={g} ghost={ghost} />
      ))}
    </group>
  );
}

function PathGroupMesh({ group, ghost }: { group: PathGroup; ghost?: boolean }) {
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
      const a = prim.path[0];
      const b = prim.path[1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      // Use horizontal length + horizontal angle (matches current beam/MEP rendering behavior)
      const horLen = Math.sqrt(dx * dx + dz * dz);
      const angle = horLen > 0.001 ? Math.atan2(-dz, dx) : 0;
      // Place at midpoint of path (unit geometry is pre-centered on origin)
      const midX = (a.x + b.x) / 2;
      const midZ = (a.z + b.z) / 2;
      const midY = Math.min(a.y, b.y);

      tempObject.position.set(midX, midY, midZ);
      tempObject.rotation.set(0, angle, 0);
      tempObject.scale.set(horLen, 1, 1);
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

  return (
    <instancedMesh
      ref={meshRef}
      args={[group.geometry, material, group.instances.length]}
      frustumCulled
      castShadow={!ghost}
      receiveShadow={!ghost}
      renderOrder={ghost ? -1 : 0}
      userData={{ indexToId }}
      {...(ghost ? { raycast: () => {} } : {})}
    />
  );
}
