import { useRef, useMemo, useEffect, useCallback } from 'react';
import { InstancedMesh, BoxGeometry, Object3D, Color, EdgesGeometry, LineBasicMaterial } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { CanonicalElement } from '../../model/elements.ts';
import { useEditorState, useEditorDispatch } from '../../state/EditorContext.tsx';
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
const unitBoxEdges = new EdgesGeometry(unitBox, 15);
const edgeMaterial = new LineBasicMaterial({ color: '#606468', transparent: true, opacity: 0.3 });
const tempObject = new Object3D();
const HIGHLIGHT_COLOR = new Color('#0d99ff');

const SHADOW_CAST_TABLES = new Set(['column', 'structure_column']);

export default function BoxInstances({ elements, tableName, materialName, levelElevation, levelElevations, ghost }: BoxInstancesProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const edgeRef = useRef<InstancedMesh>(null);
  const normalMaterial = useMaterial(tableName, materialName);
  const ghostMaterial = useGhostMaterial(tableName, materialName);
  const material = ghost ? ghostMaterial : normalMaterial;
  const dispatch = useEditorDispatch();
  const { selectedIds, hoveredId } = useEditorState();

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
    const edges = edgeRef.current;
    if (!mesh) return;

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      tempObject.position.set(b.cx, b.cy, b.cz);
      tempObject.rotation.set(0, b.rotY, 0);
      tempObject.scale.set(b.sx, b.sy, b.sz);
      tempObject.updateMatrix();
      mesh.setMatrixAt(i, tempObject.matrix);
      edges?.setMatrixAt(i, tempObject.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    if (edges) {
      edges.instanceMatrix.needsUpdate = true;
    }
  }, [boxes]);

  useEffect(() => {
    if (ghost) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    const baseColor = new Color(material.color);
    for (let i = 0; i < indexToId.length; i++) {
      const id = indexToId[i];
      if (selectedIds.has(id) || hoveredId === id) {
        mesh.setColorAt(i, HIGHLIGHT_COLOR);
      } else {
        mesh.setColorAt(i, baseColor);
      }
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [ghost, selectedIds, hoveredId, indexToId, material.color]);

  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const idx = e.instanceId;
    if (idx === undefined) return;
    const id = indexToId[idx];
    if (!id) return;
    dispatch({ type: 'SELECT', ids: [id], additive: e.nativeEvent.shiftKey });
  }, [indexToId, dispatch]);

  const handlePointerOver = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const idx = e.instanceId;
    if (idx === undefined) return;
    const id = indexToId[idx];
    if (id) dispatch({ type: 'SET_HOVER', id });
  }, [indexToId, dispatch]);

  const handlePointerOut = useCallback(() => {
    dispatch({ type: 'SET_HOVER', id: null });
  }, [dispatch]);

  if (boxes.length === 0) return null;

  const shouldCastShadow = !ghost && SHADOW_CAST_TABLES.has(tableName);

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[unitBox, material, boxes.length]}
        frustumCulled
        castShadow={shouldCastShadow}
        receiveShadow={!ghost}
        renderOrder={ghost ? -1 : 0}
        {...(ghost ? { raycast: () => {} } : { onClick: handleClick, onPointerOver: handlePointerOver, onPointerOut: handlePointerOut })}
      />
      {!ghost && (
        <instancedMesh
          ref={edgeRef}
          args={[unitBoxEdges, edgeMaterial, boxes.length]}
          frustumCulled
          raycast={() => {}}
        />
      )}
    </group>
  );
}
