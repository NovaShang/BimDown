import { useRef, useEffect, Suspense } from 'react';
import { OrbitControls, Bounds, useBounds, Environment } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import FloorGroup from './FloorGroup.tsx';
import { useEditorState } from '../state/EditorContext.tsx';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { TOUCH, MOUSE, DirectionalLight, Vector3 } from 'three';

function TrackpadOrbitControls() {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const gl = useThree(s => s.gl);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

    const canvas = gl.domElement;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) > 0)) return;
      e.preventDefault();
      e.stopPropagation();

      const camera = controls.object;
      const offset = camera.position.clone().sub(controls.target);
      const distance = offset.length();
      const panSpeed = distance * 0.001;
      const right = camera.up.clone().crossVectors(camera.up, offset).normalize();
      const up = offset.clone().cross(right).normalize();

      const panX = e.deltaX * panSpeed;
      const panY = -e.deltaY * panSpeed;

      const panDelta = right.multiplyScalar(panX).add(up.multiplyScalar(panY));
      controls.target.add(panDelta);
      camera.position.add(panDelta);
      controls.update();
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [gl]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      screenSpacePanning
      enableDamping
      dampingFactor={0.1}
      mouseButtons={{ LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.DOLLY }}
    />
  );
}

function FitOnLevelChange() {
  const bounds = useBounds();
  const { currentLevel, documentVersion } = useEditorState();
  const prevLevel = useRef('');

  useEffect(() => {
    if (currentLevel !== prevLevel.current) {
      prevLevel.current = currentLevel;
      const raf = requestAnimationFrame(() => {
        try { bounds.refresh().clip().fit(); } catch {}
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [currentLevel, documentVersion, bounds]);

  return null;
}

/** Makes the shadow-casting light follow the orbit target so shadows always cover the visible area. */
function ShadowLight() {
  const lightRef = useRef<DirectionalLight>(null);
  const controls = useThree(s => s.controls) as OrbitControlsImpl | null;

  useEffect(() => {
    if (!lightRef.current || !controls) return;
    const light = lightRef.current;

    const update = () => {
      const target = (controls as any).target as Vector3;
      // Position light relative to orbit target
      light.position.set(target.x + 60, target.y + 100, target.z + 40);
      light.target.position.copy(target);
      light.target.updateMatrixWorld();
    };

    update();
    controls.addEventListener('change', update);
    return () => controls.removeEventListener('change', update);
  }, [controls]);

  return (
    <directionalLight
      ref={lightRef}
      intensity={2.0}
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0002}
      shadow-radius={8}
      shadow-camera-left={-60}
      shadow-camera-right={60}
      shadow-camera-top={60}
      shadow-camera-bottom={-60}
      shadow-camera-near={10}
      shadow-camera-far={300}
    />
  );
}

export default function SceneContent() {
  return (
    <>
      {/* HDR environment map for PBR metal reflections (local file, CC0 license) */}
      <Suspense fallback={null}>
        <Environment files="/env.hdr" background={false} environmentIntensity={0.4} />
      </Suspense>

      {/* Low ambient for shadow contrast */}
      <ambientLight intensity={0.25} />

      {/* Key light: follows camera target, casts shadows */}
      <ShadowLight />

      {/* Fill lights for depth */}
      <directionalLight position={[-40, 60, -30]} intensity={0.4} color="#c4d4e8" />
      <directionalLight position={[0, -10, 50]} intensity={0.15} color="#e8e0d4" />
      <hemisphereLight args={['#dce8f5', '#8090a0', 0.4]} />

      <TrackpadOrbitControls />

      <Bounds fit clip margin={1.5}>
        <FitOnLevelChange />
        <FloorGroup />
      </Bounds>

      {/* Subtle ground grid */}
      <gridHelper args={[200, 100, '#c8cdd3', '#d8dce2']} />
      {/* Ground plane to receive shadows */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
        <planeGeometry args={[1000, 1000]} />
        <shadowMaterial opacity={0.2} />
      </mesh>
    </>
  );
}
