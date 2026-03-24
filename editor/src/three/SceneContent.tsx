import { useRef, useCallback, useEffect, useMemo, Suspense } from 'react';
import { OrbitControls, Bounds, useBounds, Environment } from '@react-three/drei';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { useThree } from '@react-three/fiber';
import FloorGroup from './FloorGroup.tsx';
import { useEditorState } from '../state/EditorContext.tsx';
import { parseLayer } from '../model/parse.ts';
import { computeBounds } from '../model/elements.ts';
import { useToolContext3D } from './hooks/useToolContext3D.ts';
import { useInteraction3D } from './hooks/useInteraction3D.ts';
import DrawingOverlay3D from './overlays/DrawingOverlay3D.tsx';
import SnapOverlay3D from './overlays/SnapOverlay3D.tsx';
import ResizeHandles3D from './overlays/ResizeHandles3D.tsx';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { TOUCH, MOUSE, DirectionalLight, Vector3, Plane } from 'three';

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

/** Extract model center and size from element bounds. */
function useModelBounds() {
  const { project, currentLevel } = useEditorState();
  return useMemo(() => {
    if (!project) return null;

    let elevation = 0;
    for (const l of project.levels) {
      if (l.id === currentLevel) { elevation = l.elevation; break; }
    }

    // Try current floor first, then any floor with data
    const floorsToTry = [project.floors.get(currentLevel), ...project.floors.values()];
    for (const floor of floorsToTry) {
      if (!floor) continue;
      const allElements = floor.layers.flatMap(l => parseLayer(l));
      const bounds = computeBounds(allElements);
      if (bounds) {
        return {
          cx: bounds.x + bounds.w / 2,
          cz: -(bounds.y + bounds.h / 2),
          size: Math.max(bounds.w, bounds.h) * 1.5,
          elevation,
        };
      }
    }
    return null;
  }, [project, currentLevel]);
}

function FitOnLevelChange() {
  const bounds = useBounds();
  const { currentLevel, floor3DMode } = useEditorState();
  const prevKey = useRef('');

  const doFit = useCallback(() => {
    let attempts = 0;
    const tryFit = () => {
      try {
        bounds.refresh().clip().fit();
      } catch {
        if (attempts++ < 10) requestAnimationFrame(tryFit);
      }
    };
    requestAnimationFrame(tryFit);
  }, [bounds]);

  // Re-fit when level or floor display mode changes
  useEffect(() => {
    const key = `${currentLevel}:${floor3DMode}`;
    if (key === prevKey.current) return;
    prevKey.current = key;
    doFit();
  }, [currentLevel, floor3DMode, doFit]);

  // Listen for external zoom-to-fit requests
  useEffect(() => {
    const handler = () => doFit();
    window.addEventListener('zoom-to-fit-3d', handler);
    return () => window.removeEventListener('zoom-to-fit-3d', handler);
  }, [doFit]);

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

/** Horizontal clipping planes to trim cross-floor elements to the visible elevation range. */
function ClippingController() {
  const { currentLevel, floor3DMode, project } = useEditorState();
  const gl = useThree(s => s.gl);

  useEffect(() => {
    gl.localClippingEnabled = true;

    if (floor3DMode === 'all' || !project) {
      gl.clippingPlanes = [];
      return;
    }

    const sorted = [...project.levels].sort((a, b) => a.elevation - b.elevation);
    const idx = sorted.findIndex(l => l.id === currentLevel);
    if (idx < 0) { gl.clippingPlanes = []; return; }

    const bottomIdx = floor3DMode === 'current+below' && idx > 0 ? idx - 1 : idx;
    const bottomElev = sorted[bottomIdx].elevation - 0.5; // margin below to avoid z-fighting
    const topElev = (idx < sorted.length - 1
      ? sorted[idx + 1].elevation
      : sorted[idx].elevation + 10) + 0.01; // margin above to avoid z-fighting with slab tops

    gl.clippingPlanes = [
      new Plane(new Vector3(0, 1, 0), -bottomElev),
      new Plane(new Vector3(0, -1, 0), topElev),
    ];

    return () => { gl.clippingPlanes = []; };
  }, [currentLevel, floor3DMode, project, gl]);

  return null;
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

      <ClippingController />

      {/* 3D editing interaction + overlays */}
      <InteractionLayer controlsRef={controlsRef} />

      {/* Screen-space ambient occlusion for depth/contact shadows */}
      <EffectComposer>
        <N8AO aoRadius={2} intensity={1.5} distanceFalloff={0.5} />
      </EffectComposer>

      {/* Dynamic ground grid + shadow plane at model center and current elevation */}
      <GroundPlane />
    </>
  );
}

/** Ground grid + shadow plane positioned at model center, set once after Bounds.fit. */
function GroundPlane() {
  const groupRef = useRef<any>(null);
  const controls = useThree(s => s.controls) as OrbitControlsImpl | null;
  const { currentLevel } = useEditorState();
  const modelBounds = useModelBounds();
  const size = modelBounds?.size ?? 200;
  const elevation = modelBounds?.elevation ?? 0;
  const gridDivisions = Math.max(10, Math.round(size / 2));

  // After Bounds.fit, orbit target = model center. Snap grid there once.
  const prevLevel = useRef('');
  useEffect(() => {
    if (!groupRef.current || !controls || currentLevel === prevLevel.current) return;
    prevLevel.current = currentLevel;
    // Small delay to let Bounds.fit finish first
    const timer = setTimeout(() => {
      const target = (controls as any).target as Vector3;
      groupRef.current.position.set(target.x, elevation, target.z);
    }, 200);
    return () => clearTimeout(timer);
  }, [controls, currentLevel, elevation]);

  return (
    <group ref={groupRef} position={[modelBounds?.cx ?? 0, elevation, modelBounds?.cz ?? 0]}>
      <gridHelper args={[size, gridDivisions, '#c8cdd3', '#d8dce2']} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
        <planeGeometry args={[size * 3, size * 3]} />
        <shadowMaterial opacity={0.2} />
      </mesh>
    </group>
  );
}
