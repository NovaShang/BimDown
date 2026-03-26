import { useRef, useMemo, useEffect } from 'react';
import { InstancedMesh, BoxGeometry, Object3D, Color } from 'three';
import type { CanonicalElement } from '../../model/elements.ts';
import { useSelectionState } from '../../state/EditorContext.tsx';
import { elementTo3DParams, type BoxParams } from '../utils/elementTo3D.ts';
import { useMaterial, useGhostMaterial } from '../hooks/useMaterials.ts';

interface BoxInstancesProps {
  elements: CanonicalElement[];
  tableName: string;
  materialName?: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}

const unitBox = new BoxGeometry(1, 1, 1);
const tempObject = new Object3D();
const HIGHLIGHT_COLOR = new Color('#06b6d4');

const SHADOW_CAST_TABLES = new Set(['column', 'structure_column']);

export default function BoxInstances({ elements, tableName, materialName, levelElevation, levelElevations, ghost }: BoxInstancesProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const normalMaterial = useMaterial(tableName, materialName);
  const ghostMaterial = useGhostMaterial(tableName, materialName);
  const material = ghost ? ghostMaterial : normalMaterial;
  const { selectedIds, hoveredId } = useSelectionState();

  // Track previous highlight state per instance to do delta updates
  const prevHighlightRef = useRef<boolean[]>([]);

  const { boxes, indexToId } = useMemo(() => {
    const boxes: BoxParams[] = [];
    const indexToId: string[] = [];
    for (const el of elements) {
      const params = elementTo3DParams(el, levelElevation, levelElevations);
      if (params?.kind === 'box') {
        boxes.push(params);
        indexToId.push(el.id);
      }
    }
    return { boxes, indexToId };
  }, [elements, levelElevation, levelElevations]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      tempObject.position.set(b.cx, b.cy, b.cz);
      tempObject.rotation.set(0, b.rotY, 0);
      tempObject.scale.set(b.sx, b.sy, b.sz);
      tempObject.updateMatrix();
      mesh.setMatrixAt(i, tempObject.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    // Reset highlight tracking when instances change
    prevHighlightRef.current = [];
  }, [boxes]);

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

      // Skip if highlight state unchanged (delta update)
      if (prev.length === indexToId.length && prev[i] === isHighlighted) continue;

      mesh.setColorAt(i, isHighlighted ? HIGHLIGHT_COLOR : baseColor);
      anyChanged = true;
    }

    if (anyChanged && mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }

    // Store current highlight state for next comparison
    const next = new Array<boolean>(indexToId.length);
    for (let i = 0; i < indexToId.length; i++) {
      const id = indexToId[i];
      next[i] = selectedIds.has(id) || hoveredId === id;
    }
    prevHighlightRef.current = next;
  }, [ghost, selectedIds, hoveredId, indexToId, material.color]);

  if (boxes.length === 0) return null;

  const shouldCastShadow = !ghost && SHADOW_CAST_TABLES.has(tableName);

  return (
    <instancedMesh
      ref={meshRef}
      args={[unitBox, material, boxes.length]}
      frustumCulled
      castShadow={shouldCastShadow}
      receiveShadow={!ghost}
      renderOrder={ghost ? -1 : 0}
      userData={{ indexToId }}
      {...(ghost ? { raycast: () => {} } : {})}
    />
  );
}
