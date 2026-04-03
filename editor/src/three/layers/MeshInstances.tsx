import { Suspense, useMemo, Component, type ReactNode } from 'react';
import { useLoader } from '@react-three/fiber';
import { MeshBasicMaterial, BoxGeometry } from 'three';
import { GLTFLoader, OBJLoader } from 'three-stdlib';
import type { CanonicalElement, PointElement } from '../../model/elements.ts';
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

/** Render a single loaded GLTF/OBJ mesh at the specified position. */
function LoadedMesh({ url, position, rotationY }: {
  url: string;
  position: [number, number, number];
  rotationY: number;
}) {
  const ext = url.split('.').pop()?.toLowerCase();

  if (ext === 'obj') {
    return <ObjMesh url={url} position={position} rotationY={rotationY} />;
  }
  // Default: GLTF/GLB
  return <GltfMesh url={url} position={position} rotationY={rotationY} />;
}

function GltfMesh({ url, position, rotationY }: { url: string; position: [number, number, number]; rotationY: number }) {
  const gltf = useLoader(GLTFLoader, url);
  const cloned = useMemo(() => gltf.scene.clone(true), [gltf]);
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <primitive object={cloned} />
    </group>
  );
}

function ObjMesh({ url, position, rotationY }: { url: string; position: [number, number, number]; rotationY: number }) {
  const obj = useLoader(OBJLoader, url);
  const cloned = useMemo(() => obj.clone(true), [obj]);
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <primitive object={cloned} />
    </group>
  );
}

/** Placeholder box for mesh files that fail to load or have no path. */
function PlaceholderMesh({ position, rotationY }: { position: [number, number, number]; rotationY: number }) {
  return (
    <mesh geometry={PLACEHOLDER_GEO} material={PLACEHOLDER_MAT} position={position} rotation={[0, rotationY, 0]} />
  );
}

/** Wrapper with error boundary for individual mesh loading. */
function MeshWithFallback({ url, position, rotationY }: {
  url: string;
  position: [number, number, number];
  rotationY: number;
}) {
  if (!url) {
    return <PlaceholderMesh position={position} rotationY={rotationY} />;
  }
  return (
    <Suspense fallback={<PlaceholderMesh position={position} rotationY={rotationY} />}>
      <MeshErrorBoundary fallback={<PlaceholderMesh position={position} rotationY={rotationY} />}>
        <LoadedMesh url={url} position={position} rotationY={rotationY} />
      </MeshErrorBoundary>
    </Suspense>
  );
}

/** Simple error boundary for mesh loading failures. */
class MeshErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

export default function MeshInstances({ elements, levelElevation }: MeshInstancesProps) {
  const ds = useDataSource();

  const meshItems = useMemo(() => {
    return elements
      .filter((el): el is PointElement => el.geometry === 'point')
      .map(el => {
        const meshFile = el.attrs.mesh_file ?? '';
        const url = meshFile ? ds.resolveUrl(meshFile) : '';
        const x = parseFloat(el.attrs.x ?? '0') || el.position.x;
        const y = parseFloat(el.attrs.y ?? '0') || el.position.y;
        const z = parseFloat(el.attrs.z ?? '0');
        const rotation = parseFloat(el.attrs.rotation ?? '0');
        // Model (x, y) → 3D (x, elevation+z, -y), rotation in degrees → radians around Y
        const pos: [number, number, number] = [x, levelElevation + z, -y];
        const rotY = -(rotation * Math.PI / 180);
        return { id: el.id, url, pos, rotY };
      });
  }, [elements, levelElevation, ds]);

  if (meshItems.length === 0) return null;

  return (
    <group>
      {meshItems.map(item => (
        <MeshWithFallback key={item.id} url={item.url} position={item.pos} rotationY={item.rotY} />
      ))}
    </group>
  );
}
