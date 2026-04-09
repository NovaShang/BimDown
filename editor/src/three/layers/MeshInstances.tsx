import { Suspense, useMemo, useState, useEffect, useRef, Component, type ReactNode } from 'react';
import { useLoader } from '@react-three/fiber';
import { MeshBasicMaterial, MeshStandardMaterial, BoxGeometry, Color, type Group, type Mesh } from 'three';
import { GLTFLoader, OBJLoader } from 'three-stdlib';
import type { CanonicalElement } from '../../model/elements.ts';
import { useSelectionState } from '../../state/EditorContext.tsx';
import { useDataSource } from '../../utils/DataSourceContext.tsx';

interface MeshInstancesProps {
  elements: CanonicalElement[];
  tableName: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}

const PLACEHOLDER_GEO = new BoxGeometry(0.5, 0.5, 0.5);
const PLACEHOLDER_MAT = new MeshBasicMaterial({ color: '#e53935', transparent: true, opacity: 0.4 });

function GltfMesh({ url }: { url: string }) {
  const gltf = useLoader(GLTFLoader, url);
  const cloned = useMemo(() => gltf.scene.clone(true), [gltf]);
  return <primitive object={cloned} />;
}

function ObjMesh({ url }: { url: string }) {
  const obj = useLoader(OBJLoader, url);
  const cloned = useMemo(() => obj.clone(true), [obj]);
  return <primitive object={cloned} />;
}

function LoadedMesh({ url, originalPath }: { url: string; originalPath: string }) {
  const ext = originalPath.split('.').pop()?.toLowerCase();
  if (ext === 'obj') return <ObjMesh url={url} />;
  return <GltfMesh url={url} />;
}

function PlaceholderMesh({ position }: { position?: [number, number, number] }) {
  return <mesh geometry={PLACEHOLDER_GEO} material={PLACEHOLDER_MAT} position={position} />;
}

class MeshErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

const HIGHLIGHT_COLOR = new Color('#06b6d4');

/** Apply or remove selection highlight on all meshes in a group. */
function applyHighlight(group: Group, highlighted: boolean) {
  group.traverse(obj => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as MeshStandardMaterial;
    if (!mat.emissive) return;
    if (highlighted) {
      mat.emissive.copy(HIGHLIGHT_COLOR);
      mat.emissiveIntensity = 0.4;
    } else {
      mat.emissive.setScalar(0);
      mat.emissiveIntensity = 0;
    }
  });
}

/** Resolves a mesh file path to a loadable URL via DataSource, then renders. */
function MeshElement({ meshFile, position, rotationY, elementId }: {
  meshFile: string;
  position?: [number, number, number];
  rotationY?: number;
  elementId?: string;
}) {
  const ds = useDataSource();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const groupRef = useRef<Group>(null);
  const { selectedIds, hoveredId } = useSelectionState();
  const prevHighlight = useRef(false);

  useEffect(() => {
    if (!meshFile) { setFailed(true); return; }
    let revoked = false;
    ds.resolveUrl(meshFile).then(u => {
      if (revoked) return;
      if (!u) { setFailed(true); return; }
      setUrl(u);
    }).catch(() => { if (!revoked) setFailed(true); });
    return () => { revoked = true; };
  }, [meshFile, ds]);

  // Selection/hover highlight
  const isHighlighted = !!(elementId && (selectedIds.has(elementId) || hoveredId === elementId));
  useEffect(() => {
    if (prevHighlight.current === isHighlighted) return;
    prevHighlight.current = isHighlighted;
    if (groupRef.current) applyHighlight(groupRef.current, isHighlighted);
  }, [isHighlighted]);

  if (failed || !meshFile) return <PlaceholderMesh position={position} />;
  if (!url) return null; // loading URL

  return (
    <group ref={groupRef} position={position} rotation={[0, rotationY ?? 0, 0]}
      userData={elementId ? { elementId } : undefined}
    >
      <Suspense fallback={<PlaceholderMesh />}>
        <MeshErrorBoundary fallback={<PlaceholderMesh />}>
          <LoadedMesh url={url} originalPath={meshFile} />
        </MeshErrorBoundary>
      </Suspense>
    </group>
  );
}

/**
 * Renders elements that have a mesh_file attribute. Two modes:
 *
 * 1. mesh table: GLB in local coordinates, positioned by CSV x/y/z/rotation.
 *    π base rotation flips GLB +Z (BimDown forward) to editor -Z.
 *
 * 2. Other tables (slab, roof, railing, etc.): GLB already in world coordinates
 *    (glTF Y-up matching editor scene). No transform applied.
 */
export default function MeshInstances({ elements, levelElevation }: MeshInstancesProps) {
  const meshItems = useMemo(() => {
    return elements.map(el => {
      const meshFile = el.attrs.mesh_file ?? '';

      if (el.tableName === 'mesh') {
        // Mesh table: local-coord GLB positioned by CSV
        const x = parseFloat(el.attrs.x ?? '0');
        const y = parseFloat(el.attrs.y ?? '0');
        const z = parseFloat(el.attrs.z ?? '0');
        const csvRotDeg = parseFloat(el.attrs.rotation ?? '0');
        return {
          id: el.id,
          meshFile,
          position: [x, levelElevation + z, -y] as [number, number, number],
          rotationY: Math.PI - csvRotDeg * Math.PI / 180,
        };
      }

      // Other tables: world-coord GLB, no transform
      return { id: el.id, meshFile, position: undefined, rotationY: 0 };
    });
  }, [elements, levelElevation]);

  if (meshItems.length === 0) return null;

  return (
    <group>
      {meshItems.map(item => (
        <MeshElement key={item.id} meshFile={item.meshFile} position={item.position} rotationY={item.rotationY} elementId={item.id} />
      ))}
    </group>
  );
}
