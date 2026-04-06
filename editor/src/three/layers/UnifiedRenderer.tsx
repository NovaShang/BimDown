import { useRef, useMemo, useEffect, memo } from 'react';
import {
  InstancedMesh, ExtrudeGeometry, BoxGeometry, Object3D, Color,
  type BufferGeometry, type MeshPhysicalMaterial,
} from 'three';
import type { LineElement } from '../../model/elements.ts';
import { useSelectionState } from '../../state/EditorContext.tsx';
import type { Renderer3DProps } from '../renderers/index.ts';
import { buildPrimitives } from '../builders/index.ts';
import { resolvePrimitives } from '../resolve/pipeline.ts';
import { generateSurfaceGeometry } from '../resolve/generateGeometry.ts';
import { createProfile } from '../primitives/profiles.ts';
import { profileKey } from '../primitives/profileKey.ts';
import { getBimMaterial, getGhostMaterial, type BimMaterial } from '../utils/bimMaterials.ts';
import type {
  BimPrimitive, SurfacePrimitive, PathPrimitive, InstancePrimitive,
} from '../primitives/types.ts';

const tempObject = new Object3D();
const HIGHLIGHT_COLOR = new Color('#06b6d4');

/**
 * Unified renderer handling a mixed list of SurfacePrimitive/PathPrimitive/InstancePrimitive.
 * Used for composite-producing element types (curtain_wall, stair, railing) where one
 * element expands into multiple primitive kinds.
 */
export default function UnifiedRenderer({
  elements, levelElevation, levelElevations, ghost, allElements,
}: Renderer3DProps) {
  const { surfaces, pathGroups, instanceGroups } = useMemo(() => {
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

    const built: BimPrimitive[] = [];
    for (const el of elements) {
      built.push(...buildPrimitives(el, ctx));
    }
    const resolved = resolvePrimitives(built);

    const surfaces: SurfacePrimitive[] = [];
    const paths: PathPrimitive[] = [];
    const instances: InstancePrimitive[] = [];
    for (const p of resolved) {
      if (p.kind === 'surface') surfaces.push(p);
      else if (p.kind === 'path') paths.push(p);
      else if (p.kind === 'instance') instances.push(p);
    }

    return {
      surfaces,
      pathGroups: groupPaths(paths),
      instanceGroups: groupInstances(instances),
    };
  }, [elements, levelElevation, levelElevations, ghost, allElements]);

  return (
    <group>
      {surfaces.length > 0 && <SurfaceSub primitives={surfaces} ghost={ghost} />}
      {pathGroups.map(g => <PathGroupMesh key={g.key} group={g} ghost={ghost} />)}
      {instanceGroups.map(g => <InstanceGroupMesh key={g.key} group={g} ghost={ghost} />)}
    </group>
  );
}

// ─── Surface sub-renderer ─────────────────────────────────────────────

const SurfaceMesh = memo(function SurfaceMesh({
  id, geometry, material, ghost, highlighted,
}: { id: string; geometry: BufferGeometry; material: MeshPhysicalMaterial; ghost?: boolean; highlighted: boolean }) {
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

function SurfaceSub({ primitives, ghost }: { primitives: SurfacePrimitive[]; ghost?: boolean }) {
  const { selectedIds, hoveredId } = useSelectionState();
  const meshes = useMemo(() => {
    const result: { id: string; geometry: BufferGeometry; material: MeshPhysicalMaterial }[] = [];
    for (const prim of primitives) {
      const primForGen = ghost ? { ...prim, openings: undefined } : prim;
      const geo = generateSurfaceGeometry(primForGen);
      if (!geo) continue;
      const mat = ghost ? getGhostMaterial(prim.material) : getBimMaterial(prim.material);
      result.push({ id: prim.elementId, geometry: geo, material: mat });
    }
    return result;
  }, [primitives, ghost]);

  return (
    <>
      {meshes.map(m => (
        <SurfaceMesh
          key={m.id + ':' + m.geometry.uuid}
          id={m.id} geometry={m.geometry} material={m.material}
          ghost={ghost}
          highlighted={!ghost && (selectedIds.has(m.id) || hoveredId === m.id)}
        />
      ))}
    </>
  );
}

// ─── Path grouping + rendering ───────────────────────────────────────

interface PathGroup {
  key: string;
  material: BimMaterial;
  geometry: BufferGeometry;
  instances: PathPrimitive[];
}

function groupPaths(paths: PathPrimitive[]): PathGroup[] {
  const byKey = new Map<string, PathGroup>();
  for (const prim of paths) {
    const key = `${profileKey(prim.profile)}|${prim.material}`;
    let group = byKey.get(key);
    if (!group) {
      const shape = createProfile(prim.profile);
      const geo = new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
      geo.rotateY(Math.PI / 2);
      geo.translate(-0.5, 0, 0);
      group = { key, material: prim.material, geometry: geo, instances: [] };
      byKey.set(key, group);
    }
    group.instances.push(prim);
  }
  return [...byKey.values()];
}

function PathGroupMesh({ group, ghost }: { group: PathGroup; ghost?: boolean }) {
  const meshRef = useRef<InstancedMesh>(null);
  const { selectedIds, hoveredId } = useSelectionState();
  const prevHighlightRef = useRef<boolean[]>([]);

  const material = useMemo(
    () => ghost ? getGhostMaterial(group.material) : getBimMaterial(group.material),
    [ghost, group.material],
  );
  const indexToId = useMemo(() => group.instances.map(p => p.elementId), [group.instances]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < group.instances.length; i++) {
      const p = group.instances[i];
      const a = p.path[0], b = p.path[1];
      const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
      const horLen = Math.sqrt(dx * dx + dz * dz);
      const fullLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // For vertical paths (mullions), horLen=0 but fullLen>0. Orient with vertical axis.
      if (horLen < 0.001 && Math.abs(dy) > 0.001) {
        // Vertical: rotate so local +X points up (i.e. around Z by π/2)
        tempObject.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        tempObject.rotation.set(0, 0, Math.PI / 2);
        tempObject.scale.set(fullLen, 1, 1);
      } else {
        const angle = horLen > 0.001 ? Math.atan2(-dz, dx) : 0;
        tempObject.position.set((a.x + b.x) / 2, Math.min(a.y, b.y) + Math.abs(dy) / 2, (a.z + b.z) / 2);
        tempObject.rotation.set(0, angle, 0);
        tempObject.scale.set(horLen > 0.001 ? horLen : fullLen, 1, 1);
      }
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
      const hi = selectedIds.has(id) || hoveredId === id;
      if (prev.length === indexToId.length && prev[i] === hi) continue;
      mesh.setColorAt(i, hi ? HIGHLIGHT_COLOR : baseColor);
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

// ─── Instance grouping + rendering ───────────────────────────────────

interface InstanceGroup {
  key: string;
  material: BimMaterial;
  geometry: BufferGeometry;
  instances: InstancePrimitive[];
}

function groupInstances(instances: InstancePrimitive[]): InstanceGroup[] {
  const byKey = new Map<string, InstanceGroup>();
  for (const prim of instances) {
    const sk = sourceKey(prim);
    if (!sk) continue;
    const key = `${sk}|${prim.material}`;
    let group = byKey.get(key);
    if (!group) {
      const geo = createInstanceGeometry(prim);
      if (!geo) continue;
      group = { key, material: prim.material, geometry: geo, instances: [] };
      byKey.set(key, group);
    }
    group.instances.push(prim);
  }
  return [...byKey.values()];
}

function sourceKey(prim: InstancePrimitive): string | null {
  const s = prim.source;
  switch (s.type) {
    case 'profile':  return `profile:${profileKey(s.profile)}:${s.height}`;
    case 'box':      return 'box';
    case 'mesh':     return null; // handled separately in Phase 6
    case 'geometry': return `geometry:${s.geometry.uuid}`;
  }
}

function createInstanceGeometry(prim: InstancePrimitive): BufferGeometry | null {
  const s = prim.source;
  switch (s.type) {
    case 'profile': {
      const shape = createProfile(s.profile);
      const geo = new ExtrudeGeometry(shape, { depth: s.height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      return geo;
    }
    case 'box':      return new BoxGeometry(1, 1, 1);
    case 'geometry': return s.geometry;
    case 'mesh':     return null;
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
  const indexToId = useMemo(() => group.instances.map(p => p.elementId), [group.instances]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < group.instances.length; i++) {
      const p = group.instances[i];
      tempObject.position.set(p.position.x, p.position.y, p.position.z);
      tempObject.rotation.set(p.rotation.x, p.rotation.y, p.rotation.z);
      tempObject.scale.set(p.scale.x, p.scale.y, p.scale.z);
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
      const hi = selectedIds.has(id) || hoveredId === id;
      if (prev.length === indexToId.length && prev[i] === hi) continue;
      mesh.setColorAt(i, hi ? HIGHLIGHT_COLOR : baseColor);
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
