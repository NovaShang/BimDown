import { useMemo, useCallback } from 'react';
import { Shape, ExtrudeGeometry, EdgesGeometry, BufferGeometry, LineBasicMaterial, type MeshPhysicalMaterial } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { CanonicalElement, LineElement } from '../../model/elements.ts';
import { useEditorState, useEditorDispatch } from '../../state/EditorContext.tsx';
import { computeCornerAdjustments, type WallSegment } from '../../utils/wallMiter.ts';
import { resolveHeight } from '../utils/elementTo3D.ts';
import { resolveBimMaterial, getBimMaterial, getGhostMaterial } from '../utils/bimMaterials.ts';

interface WallExtrusionsProps {
  elements: CanonicalElement[];
  tableName: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}

const DEFAULT_WALL_HEIGHT = 3.0;

const edgeMaterial = new LineBasicMaterial({ color: '#606468', transparent: true, opacity: 0.3 });

interface WallMeshData {
  id: string;
  geometry: BufferGeometry;
  edgeGeometry: EdgesGeometry;
  material: MeshPhysicalMaterial;
}

export default function WallExtrusions({ elements, tableName, levelElevation, levelElevations, ghost }: WallExtrusionsProps) {
  const dispatch = useEditorDispatch();
  const { selectedIds, hoveredId } = useEditorState();

  const meshes = useMemo(() => {
    const walls = elements.filter((el): el is LineElement => el.geometry === 'line');
    if (walls.length === 0) return [];

    const segments: WallSegment[] = walls.map(w => ({
      id: w.id,
      x1: w.start.x, y1: w.start.y,
      x2: w.end.x, y2: w.end.y,
      halfWidth: w.strokeWidth / 2,
      fill: '',
    }));

    const { adjustments: adj } = computeCornerAdjustments(segments);

    const result: WallMeshData[] = [];
    for (const w of walls) {
      const { height, baseOffset } = resolveHeight(w.attrs, levelElevation, levelElevations, DEFAULT_WALL_HEIGHT);
      const baseY = levelElevation + baseOffset;

      const hw = Math.max(w.strokeWidth, tableName === 'curtain_wall' ? 0.15 : 0) / 2;
      const dx = w.end.x - w.start.x;
      const dy = w.end.y - w.start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) continue;
      const nx = -dy / len;
      const ny = dx / len;

      let p1x = w.start.x + nx * hw, p1y = w.start.y + ny * hw;
      let p2x = w.end.x + nx * hw, p2y = w.end.y + ny * hw;
      let p3x = w.end.x - nx * hw, p3y = w.end.y - ny * hw;
      let p4x = w.start.x - nx * hw, p4y = w.start.y - ny * hw;

      const startAdj = adj.get(`${w.id}:start`);
      if (startAdj) {
        p1x = startAdj.left.x;  p1y = startAdj.left.y;
        p4x = startAdj.right.x; p4y = startAdj.right.y;
      }
      const endAdj = adj.get(`${w.id}:end`);
      if (endAdj) {
        p2x = endAdj.right.x; p2y = endAdj.right.y;
        p3x = endAdj.left.x;  p3y = endAdj.left.y;
      }

      const shape = new Shape();
      shape.moveTo(p1x, p1y);
      shape.lineTo(p2x, p2y);
      shape.lineTo(p3x, p3y);
      shape.lineTo(p4x, p4y);
      shape.closePath();

      const geo = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, baseY, 0);

      const bimMat = resolveBimMaterial(w.attrs.material, tableName);
      const mat = ghost ? getGhostMaterial(bimMat) : getBimMaterial(bimMat);

      result.push({ id: w.id, geometry: geo, edgeGeometry: new EdgesGeometry(geo, 15), material: mat });
    }
    return result;
  }, [elements, tableName, levelElevation, levelElevations, ghost]);

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
      {meshes.map(({ id, geometry, edgeGeometry, material }) => {
        const isHighlighted = !ghost && (selectedIds.has(id) || hoveredId === id);
        return (
          <group key={id}>
            <mesh
              geometry={geometry}
              material={material}
              castShadow={!ghost}
              receiveShadow
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
                <meshStandardMaterial attach="material" color="#0d99ff"
                  transparent={material.transparent} opacity={Math.max(material.opacity, 0.4)} />
              )}
            </mesh>
            {!ghost && <lineSegments geometry={edgeGeometry} material={edgeMaterial} />}
          </group>
        );
      })}
    </group>
  );
}
