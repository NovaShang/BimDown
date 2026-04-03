import { Suspense, useMemo, useState, useEffect, Component, type ReactNode } from 'react';
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

/** Resolves a mesh file path to a loadable URL via DataSource, then renders. */
function MeshElement({ meshFile, position }: { meshFile: string; position?: [number, number, number] }) {
  const ds = useDataSource();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

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

  if (failed || !meshFile) return <PlaceholderMesh position={position} />;
  if (!url) return null; // loading URL

  return (
    <Suspense fallback={<PlaceholderMesh position={position} />}>
      <MeshErrorBoundary fallback={<PlaceholderMesh position={position} />}>
        <LoadedMesh url={url} originalPath={meshFile} />
      </MeshErrorBoundary>
    </Suspense>
  );
}

export default function MeshInstances({ elements, levelElevation }: MeshInstancesProps) {
  const meshItems = useMemo(() => {
    return elements.map(el => {
      const meshFile = el.attrs.mesh_file ?? '';

      // For mesh table elements: use explicit x/y/z for positioning
      // For other types (wall, railing, etc.): mesh assumed to contain world coordinates
      let position: [number, number, number] | undefined;
      if (el.tableName === 'mesh' && el.geometry === 'point') {
        const x = parseFloat(el.attrs.x ?? '0') || el.position.x;
        const y = parseFloat(el.attrs.y ?? '0') || el.position.y;
        const z = parseFloat(el.attrs.z ?? '0');
        position = [x, levelElevation + z, -y];
      }

      return { id: el.id, meshFile, position };
    });
  }, [elements, levelElevation]);

  if (meshItems.length === 0) return null;

  return (
    <group>
      {meshItems.map(item => (
        <MeshElement key={item.id} meshFile={item.meshFile} position={item.position} />
      ))}
    </group>
  );
}
