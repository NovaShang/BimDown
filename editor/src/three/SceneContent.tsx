import { useRef, useEffect, useMemo, useCallback, Suspense } from 'react';
import { OrbitControls, Environment } from '@react-three/drei';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { useThree } from '@react-three/fiber';
import FloorGroup from './FloorGroup.tsx';
import { useEditorState, useCoreEditorState } from '../state/EditorContext.tsx';
import { parseLayer } from '../model/parse.ts';
import { computeBounds } from '../model/elements.ts';
import { useToolContext3D } from './hooks/useToolContext3D.ts';
import { useInteraction3D } from './hooks/useInteraction3D.ts';
import DrawingOverlay3D from './overlays/DrawingOverlay3D.tsx';
import SnapOverlay3D from './overlays/SnapOverlay3D.tsx';
import ResizeHandles3D from './overlays/ResizeHandles3D.tsx';
import Grids3D from './overlays/Grids3D.tsx';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { TOUCH, MOUSE, DirectionalLight, Vector3, Plane, PerspectiveCamera, type Group } from 'three';
import { visibleBox, fitCameraToBox, type Vec3 } from './cameraFit.ts';
import { SectionBoxController, type SectionBoxBridge } from './SectionBox.tsx';
import SectionCaps from './SectionCaps.tsx';
import { sectionBoxPlanes, toWorldPlane } from '../views/viewGeometry.ts';
import type { SectionBoxBounds } from '../views/viewTypes.ts';

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

/**
 * Frames the model: orbit target at the centre of the rendered floors, camera
 * far enough back that every corner is in view. Runs once per opened project
 * (an empty project is framed as soon as it gets content, e.g. the AI's first
 * build) and on the toolbar's zoom-to-fit (`zoom-to-fit-3d` window event).
 */
function CameraFit({ modelRef }: { modelRef: React.RefObject<Group | null> }) {
  const { project, modelName, floor3DMode, currentLevel, views } = useEditorState();
  const sectionBoxRef = useRef(views.sectionBox.enabled ? views.sectionBox.bounds : null);
  sectionBoxRef.current = views.sectionBox.enabled ? views.sectionBox.bounds : null;
  const camera = useThree(s => s.camera);
  const width = useThree(s => s.size.width);
  const height = useThree(s => s.size.height);
  const controls = useThree(s => s.controls) as OrbitControlsImpl | null;
  const fittedFor = useRef<string | null>(null);

  const fit = useCallback((): boolean => {
    if (!project || !modelRef.current || !controls || !(camera instanceof PerspectiveCamera) || width === 0 || height === 0) return false;
    // With the section box on, frame the box rather than the whole model.
    const sb = sectionBoxRef.current;
    const box = sb ? { min: [sb.minX, sb.minZ, -sb.maxY] as Vec3, max: [sb.maxX, sb.maxZ, -sb.minY] as Vec3 } : visibleBox(modelRef.current);
    if (!box) return false;
    const { target, position, distance } = fitCameraToBox(box, camera.fov, width / height);
    controls.target.set(...target);
    camera.position.set(...position);
    camera.far = Math.max(camera.far, distance * 10);
    camera.updateProjectionMatrix();
    controls.update();
    return true;
  // project/floor mode/level: re-measure after the model or the visible floors change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, floor3DMode, currentLevel, modelRef, controls, camera, width, height]);

  useEffect(() => {
    if (fittedFor.current !== modelName && fit()) fittedFor.current = modelName;
  }, [fit, modelName]);

  useEffect(() => {
    const onFit = () => { fit(); };
    window.addEventListener('zoom-to-fit-3d', onFit);
    return () => window.removeEventListener('zoom-to-fit-3d', onFit);
  }, [fit]);

  return null;
}

/** Makes the shadow-casting light follow the orbit target so shadows always cover the visible area. */
function ShadowLight({ castShadow = true }: { castShadow?: boolean }) {
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
      castShadow={castShadow}
      shadow-mapSize={[1024, 1024]}
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

/** Elevation range [bottom, top] shown in single-floor modes, or null for all floors. */
function useFloorZRange(): [number, number] | null {
  const { currentLevel, floor3DMode, project } = useEditorState();
  return useMemo(() => {
    if (floor3DMode === 'all' || !project) return null;
    const sorted = [...project.levels].sort((a, b) => a.elevation - b.elevation);
    const idx = sorted.findIndex(l => l.id === currentLevel);
    if (idx < 0) return null;
    const bottomIdx = floor3DMode === 'current+below' && idx > 0 ? idx - 1 : idx;
    const bottomElev = sorted[bottomIdx].elevation - 0.5; // margin below to avoid z-fighting
    const topElev = (idx < sorted.length - 1
      ? sorted[idx + 1].elevation
      : sorted[idx].elevation + 10) + 0.01; // margin above to avoid z-fighting with slab tops
    return [bottomElev, topElev];
  }, [currentLevel, floor3DMode, project]);
}

/**
 * Renderer clipping planes: the section box when it is on, otherwise two
 * horizontal planes trimming cross-floor elements to the visible floor range.
 */
function ClippingController({ zRange, bridge }: { zRange: [number, number] | null; bridge: SectionBoxBridge }) {
  const { views } = useEditorState();
  const gl = useThree(s => s.gl);
  const invalidate = useThree(s => s.invalidate);
  const { enabled, bounds } = views.sectionBox;

  useEffect(() => {
    gl.localClippingEnabled = true;

    if (enabled && bounds) {
      const planes = sectionBoxPlanes(bounds).map(() => new Plane());
      const apply = (b: SectionBoxBounds) => {
        sectionBoxPlanes(b).forEach((p, i) => {
          const w = toWorldPlane(p);
          planes[i].normal.set(...w.normal);
          planes[i].constant = w.constant;
        });
        invalidate();
      };
      apply(bounds);
      gl.clippingPlanes = planes;
      bridge.applyLive = apply;
      return () => { gl.clippingPlanes = []; bridge.applyLive = null; };
    }

    if (!zRange) { gl.clippingPlanes = []; return; }
    gl.clippingPlanes = [
      new Plane(new Vector3(0, 1, 0), -zRange[0]),
      new Plane(new Vector3(0, -1, 0), zRange[1]),
    ];

    return () => { gl.clippingPlanes = []; };
  }, [zRange, enabled, bounds, gl, bridge, invalidate]);

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
    const sid = state.selectedIds.values().next().value!;
    const rawId = sid.includes(':') ? sid.slice(sid.indexOf(':') + 1) : sid;
    return state.document.elements.get(rawId) ?? null;
  }, [state.selectedIds, state.document, state.documentVersion]);

  return (
    <>
      <DrawingOverlay3D elevation={elevation} />
      <SnapOverlay3D snap={activeSnap} elevation={elevation} />
      {selectedElement && (state.activeTool === 'select' || state.activeTool === 'orbit') && (
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

export default function SceneContent({ sectionBox }: { sectionBox: SectionBoxBridge }) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const modelRef = useRef<Group>(null);
  const zRange = useFloorZRange();
  // Section box: clipped solids get filled cut faces; shadows are off because
  // renderer planes don't clip the shadow pass (a removed roof would still shade).
  const state = useCoreEditorState();
  const { enabled: boxOn, bounds: boxBounds } = state.views.sectionBox;
  const capPlanes = useMemo(() => (boxOn && boxBounds ? sectionBoxPlanes(boxBounds).map(p => {
    const w = toWorldPlane(p);
    return new Plane(new Vector3(...w.normal), w.constant);
  }) : []), [boxOn, boxBounds]);

  return (
    <>
      {/* HDR environment map for PBR metal reflections (local file, CC0 license) */}
      <Suspense fallback={null}>
        <Environment files="/env.hdr" background={false} environmentIntensity={0.4} />
      </Suspense>

      {/* Low ambient for shadow contrast */}
      <ambientLight intensity={0.25} />

      {/* Key light: follows camera target, casts shadows */}
      <ShadowLight castShadow={!boxOn} />

      {/* Fill lights for depth */}
      <directionalLight position={[-40, 60, -30]} intensity={0.4} color="#c4d4e8" />
      <directionalLight position={[0, -10, 50]} intensity={0.15} color="#e8e0d4" />
      <hemisphereLight args={['#dce8f5', '#8090a0', 0.4]} />

      <TrackpadOrbitControls controlsRef={controlsRef} />
      <CameraFit modelRef={modelRef} />

      <group ref={modelRef}>
        <FloorGroup />
      </group>

      <ClippingController zRange={zRange} bridge={sectionBox} />
      <SectionCaps rootRef={modelRef} planes={capPlanes} color="#4b5563" isHidden={() => sectionBox.dragging}
        deps={[state.project, state.document, state.documentVersion, state.visibleLayers, state.activeDiscipline, state.showArchContext, state.floor3DMode, state.currentLevel]} />
      <SectionBoxController modelRef={modelRef} bridge={sectionBox} zRange={zRange} />

      {/* Grid axes at the current level (view option) */}
      <Grids3D />

      {/* 3D editing interaction + overlays */}
      <InteractionLayer controlsRef={controlsRef} />

      {/* Screen-space ambient occlusion for depth/contact shadows */}
      <EffectComposer>
        <N8AO aoRadius={1} intensity={1} distanceFalloff={0.5} halfRes />
      </EffectComposer>

      {/* Dynamic ground grid + shadow plane at model center and current elevation */}
      <GroundPlane />
    </>
  );
}

/** Ground grid + shadow plane positioned at model center, set once after CameraFit. */
function GroundPlane() {
  const groupRef = useRef<any>(null);
  const controls = useThree(s => s.controls) as OrbitControlsImpl | null;
  const { currentLevel } = useEditorState();
  const modelBounds = useModelBounds();
  const size = modelBounds?.size ?? 200;
  const elevation = modelBounds?.elevation ?? 0;
  const gridDivisions = Math.max(10, Math.round(size / 2));

  // After CameraFit, orbit target = model center. Snap grid there once.
  const prevLevel = useRef('');
  useEffect(() => {
    if (!groupRef.current || !controls || currentLevel === prevLevel.current) return;
    prevLevel.current = currentLevel;
    // Small delay to let CameraFit run first
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
