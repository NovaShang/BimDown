import { useMemo, useCallback } from 'react';
import { Shape, ExtrudeGeometry, EdgesGeometry, BufferGeometry, LineBasicMaterial } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { CanonicalElement } from '../../model/elements.ts';
import { useEditorState, useEditorDispatch } from '../../state/EditorContext.tsx';
import { elementTo3DParams, type ExtrudeParams } from '../utils/elementTo3D.ts';

interface SpaceWireframesProps {
  elements: CanonicalElement[];
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}

const WIRE_MATERIAL = new LineBasicMaterial({ color: '#7eb8da', transparent: true, opacity: 0.6 });
const WIRE_GHOST_MATERIAL = new LineBasicMaterial({ color: '#7eb8da', transparent: true, opacity: 0.15 });
const WIRE_HIGHLIGHT_MATERIAL = new LineBasicMaterial({ color: '#0d99ff', opacity: 1 });

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

interface SpaceMeshData {
  id: string;
  edgeGeometry: EdgesGeometry;
}

export default function SpaceWireframes({ elements, levelElevation, levelElevations, ghost }: SpaceWireframesProps) {
  const dispatch = useEditorDispatch();
  const { selectedIds, hoveredId } = useEditorState();

  const meshes = useMemo(() => {
    const result: SpaceMeshData[] = [];
    for (const el of elements) {
      const params = elementTo3DParams(el, levelElevation, levelElevations);
      if (params?.kind === 'extrude') {
        const geo = createExtrudeGeometry(params);
        if (geo) {
          const edges = new EdgesGeometry(geo, 15);
          geo.dispose();
          result.push({ id: el.id, edgeGeometry: edges });
        }
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

  const baseMaterial = ghost ? WIRE_GHOST_MATERIAL : WIRE_MATERIAL;

  return (
    <group>
      {meshes.map(({ id, edgeGeometry }) => {
        const isHighlighted = !ghost && (selectedIds.has(id) || hoveredId === id);
        return (
          <lineSegments
            key={id}
            geometry={edgeGeometry}
            material={isHighlighted ? WIRE_HIGHLIGHT_MATERIAL : baseMaterial}
            {...(ghost
              ? { raycast: () => {} }
              : {
                  onClick: (e: ThreeEvent<MouseEvent>) => handleClick(id, e),
                  onPointerOver: (e: ThreeEvent<PointerEvent>) => handlePointerOver(id, e),
                  onPointerOut: handlePointerOut,
                }
            )}
          />
        );
      })}
    </group>
  );
}
