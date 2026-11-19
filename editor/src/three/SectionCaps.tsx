import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DoubleSide, LineBasicMaterial, MeshBasicMaterial, type BufferGeometry, type Group, type Object3D, type Plane } from 'three';
import { computeCaps, capBufferGeometry } from './sectionCaps.ts';

interface CapMesh { fill: BufferGeometry; outline: BufferGeometry; triIds: string[] }

/**
 * Filled cut faces + outlines for `planes` (world planes, normal pointing to the
 * kept side), sliced from the meshes under `rootRef`. Recomputed when `deps`
 * change (after the model has re-rendered); `isHidden` is polled every frame
 * (e.g. while a section-box face is being dragged and the caps are stale).
 */
export default function SectionCaps({ rootRef, planes, deps, color = '#374151', outlineColor = '#0f172a', isHidden }: {
  rootRef: React.RefObject<Object3D | null>;
  planes: Plane[];
  deps: unknown[];
  color?: string;
  outlineColor?: string;
  isHidden?: () => boolean;
}) {
  const invalidate = useThree(s => s.invalidate);
  const [caps, setCaps] = useState<CapMesh[]>([]);
  const groupRef = useRef<Group>(null);
  const fillMat = useMemo(() => new MeshBasicMaterial({ color, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), [color]);
  const lineMat = useMemo(() => new LineBasicMaterial({ color: outlineColor }), [outlineColor]);

  useEffect(() => {
    // Let freshly rendered element meshes mount before slicing them.
    const t = setTimeout(() => {
      const root = rootRef.current;
      if (!root || planes.length === 0) { setCaps(prev => (prev.length ? [] : prev)); return; }
      setCaps(planes.map(p => {
        const c = computeCaps(root, p);
        return { fill: capBufferGeometry(c.fill), outline: capBufferGeometry(c.outline), triIds: c.triIds };
      }));
      invalidate();
    }, 60);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planes, rootRef, invalidate, ...deps]);

  useEffect(() => () => { caps.forEach(c => { c.fill.dispose(); c.outline.dispose(); }); }, [caps]);
  useEffect(() => () => { fillMat.dispose(); lineMat.dispose(); }, [fillMat, lineMat]);

  useFrame(() => {
    if (groupRef.current && isHidden) groupRef.current.visible = !isHidden();
  });

  return (
    <group ref={groupRef} name="section-caps">
      {caps.map((c, i) => (
        <group key={i}>
          <mesh geometry={c.fill} material={fillMat} userData={{ faceToId: c.triIds }} renderOrder={1} />
          <lineSegments geometry={c.outline} material={lineMat} renderOrder={2} raycast={() => null} />
        </group>
      ))}
    </group>
  );
}
