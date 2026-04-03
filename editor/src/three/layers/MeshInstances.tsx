import { Suspense, useMemo, Component, type ReactNode } from 'react';
import { useLoader } from '@react-three/fiber';
import { MeshBasicMaterial, BoxGeometry } from 'three';
import { GLTFLoader, OBJLoader } from 'three-stdlib';
import type { CanonicalElement } from '../../model/elements.ts';
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

function LoadedMesh({ url }: { url: string }) {
  const ext = url.split('.').pop()?.toLowerCase();
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

function MeshWithFallback({ url, position }: { url: string; position?: [number, number, number] }) {
  if (!url) return <PlaceholderMesh position={position} />;
  return (
    <Suspense fallback={<PlaceholderMesh position={position} />}>
      <MeshErrorBoundary fallback={<PlaceholderMesh position={position} />}>
        <LoadedMesh url={url} />
      </MeshErrorBoundary>
    </Suspense>
  );
}

export default function MeshInstances({ elements, levelElevation }: MeshInstancesProps) {
  const ds = useDataSource();

  const meshItems = useMemo(() => {
    return elements.map(el => {
      const meshFile = el.attrs.mesh_file ?? '';
      const url = meshFile ? ds.resolveUrl(meshFile) : '';

      // For mesh table elements: use explicit x/y/z/rotation for positioning
      // For other types (wall, railing, etc.): mesh file assumed to contain world coordinates
      let position: [number, number, number] | undefined;
      if (el.tableName === 'mesh' && el.geometry === 'point') {
        const x = parseFloat(el.attrs.x ?? '0') || el.position.x;
        const y = parseFloat(el.attrs.y ?? '0') || el.position.y;
        const z = parseFloat(el.attrs.z ?? '0');
        position = [x, levelElevation + z, -y];
      }

      return { id: el.id, url, position };
    });
  }, [elements, levelElevation, ds]);

  if (meshItems.length === 0) return null;

  return (
    <group>
      {meshItems.map(item => (
        <MeshWithFallback key={item.id} url={item.url} position={item.position} />
      ))}
    </group>
  );
}
