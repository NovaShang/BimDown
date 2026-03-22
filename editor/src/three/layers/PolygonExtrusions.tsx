import { useMemo, useCallback } from 'react';
import { Shape, ExtrudeGeometry, BufferGeometry } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { CanonicalElement } from '../../model/elements.ts';
import { useEditorState, useEditorDispatch } from '../../state/EditorContext.tsx';
import { elementTo3DParams, type ExtrudeParams } from '../utils/elementTo3D.ts';
import { useMaterial, useGhostMaterial } from '../hooks/useMaterials.ts';

interface PolygonExtrusionsProps {
  elements: CanonicalElement[];
  tableName: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}

function createExtrudeGeometry(params: ExtrudeParams): BufferGeometry | null {
  if (params.vertices.length < 3) return null;

  const shape = new Shape();
  shape.moveTo(params.vertices[0].x, params.vertices[0].y);
  for (let i = 1; i < params.vertices.length; i++) {
    shape.lineTo(params.vertices[i].x, params.vertices[i].y);
  }
  shape.closePath();

  const geo = new ExtrudeGeometry(shape, {
    depth: params.height,
    bevelEnabled: false,
  });

  geo.rotateX(-Math.PI / 2);
  geo.translate(0, params.baseY, 0);

  return geo;
}

interface PolygonMeshData {
  id: string;
  geometry: BufferGeometry;
}

export default function PolygonExtrusions({ elements, tableName, levelElevation, levelElevations, ghost }: PolygonExtrusionsProps) {
  const normalMaterial = useMaterial(tableName);
  const ghostMaterial = useGhostMaterial(tableName);
  const material = ghost ? ghostMaterial : normalMaterial;
  const dispatch = useEditorDispatch();
  const { selectedIds, hoveredId } = useEditorState();

  const meshes = useMemo(() => {
    const result: PolygonMeshData[] = [];
    for (const el of elements) {
      const params = elementTo3DParams(el, levelElevation, levelElevations);
      if (params?.kind === 'extrude') {
        const geo = createExtrudeGeometry(params);
        if (geo) result.push({ id: el.id, geometry: geo });
      }
    }
    return result;
  }, [elements, levelElevation, levelElevations]);

  const handleClick = useCallback((id: string, e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    dispatch({ type: 'SELECT', ids: [id], additive: e.nativeEvent.shiftKey });
  }, [dispatch]);

  const handlePointerOver = useCallback((id: string, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    dispatch({ type: 'SET_HOVER', id });
  }, [dispatch]);

  const handlePointerOut = useCallback(() => {
    dispatch({ type: 'SET_HOVER', id: null });
  }, [dispatch]);

  if (meshes.length === 0) return null;

  return (
    <group>
      {meshes.map(({ id, geometry }) => {
        const isHighlighted = !ghost && (selectedIds.has(id) || hoveredId === id);
        return (
          <mesh
            key={id}
            geometry={geometry}
            material={material}
            renderOrder={ghost ? -1 : 0}
            {...(ghost
              ? { raycast: () => {} }
              : {
                  onClick: (e: ThreeEvent<MouseEvent>) => handleClick(id, e),
                  onPointerOver: (e: ThreeEvent<PointerEvent>) => handlePointerOver(id, e),
                  onPointerOut: handlePointerOut,
                }
            )}
          >
            {isHighlighted && (
              <meshStandardMaterial
                attach="material"
                color="#0d99ff"
                transparent={material.transparent}
                opacity={Math.max(material.opacity, 0.4)}
              />
            )}
          </mesh>
        );
      })}
    </group>
  );
}
