import { useRef, useEffect, useMemo, Suspense } from 'react';
import { OrbitControls, Bounds, useBounds, Environment } from '@react-three/drei';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { useThree } from '@react-three/fiber';
import FloorGroup from './FloorGroup.tsx';
import { useEditorState } from '../state/EditorContext.tsx';
import { useToolContext3D } from './hooks/useToolContext3D.ts';
import { useInteraction3D } from './hooks/useInteraction3D.ts';
import DrawingOverlay3D from './overlays/DrawingOverlay3D.tsx';
import SnapOverlay3D from './overlays/SnapOverlay3D.tsx';
import ResizeHandles3D from './overlays/ResizeHandles3D.tsx';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { TOUCH, MOUSE, DirectionalLight, Vector3 } from 'three';

function TrackpadOrbitControls({ controlsRef }: { controlsRef: React.RefObject<OrbitControlsImpl | null> }) {
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
  }, [gl, controlsRef]);

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

/** Resolve current floor elevation from project levels. */
function useFloorElevation(): number {
  const { project, currentLevel } = useEditorState();
  return useMemo(() => {
    if (!project) return 0;
    for (const l of project.levels) {
      if (l.id === currentLevel) return l.elevation;
    }
    return 0;
  }, [project, currentLevel]);
}

function InteractionLayer({ controlsRef }: { controlsRef: React.RefObject<OrbitControlsImpl | null> }) {
  const elevation = useFloorElevation();
  const { toolCtx, hitElementIdRef, activeSnap, resizeDraggingRef } = useToolContext3D(elevation);

  useInteraction3D({ toolCtx, hitElementIdRef, floorElevation: elevation, controlsRef, resizeDraggingRef });

  const state = useEditorState();
  const selectedElement = useMemo(() => {
    if (state.selectedIds.size !== 1 || !state.document) return null;
    const id = state.selectedIds.values().next().value;
    return state.document.elements.get(id!) ?? null;
  }, [state.selectedIds, state.document, state.documentVersion]);

  return (
    <>
      <DrawingOverlay3D elevation={elevation} />
      <SnapOverlay3D snap={activeSnap} elevation={elevation} />
      {selectedElement && (
        <ResizeHandles3D
          element={selectedElement}
          elevation={elevation}
          screenToSvg={toolCtx.screenToSvg}
          resizeDraggingRef={resizeDraggingRef}
          controlsRef={controlsRef}
        />
      )}
    </>
  );
}

export default function SceneContent() {
  const controlsRef = useRef<OrbitControlsImpl>(null);

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

      <TrackpadOrbitControls controlsRef={controlsRef} />

      <Bounds fit clip margin={1.5}>
        <FitOnLevelChange />
        <FloorGroup />
      </Bounds>

      {/* 3D editing interaction + overlays */}
      <InteractionLayer controlsRef={controlsRef} />

      {/* Screen-space ambient occlusion for depth/contact shadows */}
      <EffectComposer>
        <N8AO aoRadius={2} intensity={1.5} distanceFalloff={0.5} />
      </EffectComposer>

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
