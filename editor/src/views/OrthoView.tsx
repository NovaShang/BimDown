/**
 * Elevation / section view: the 3D model through an orthographic camera looking
 * horizontally, with level lines + heads and grid bubbles drawn as an SVG overlay.
 * Sections clip the model at the cut line (renderer planes, this canvas only) and
 * paint cut faces with a dark poche (clipCaps).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { MOUSE, OrthographicCamera, Plane, Raycaster, Vector2, Vector3, type Group, type Intersection, type Object3D } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import FloorGroup from '../three/FloorGroup.tsx';
import SectionCaps from '../three/SectionCaps.tsx';
import { isPointVisible } from '../three/clipHit.ts';
import { visibleBox } from '../three/cameraFit.ts';
import { useCoreEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import { toLevelId } from '../model/ids.ts';
import type { OpenView } from './viewTypes.ts';
import {
  viewFrame, toWorldPlane, worldBoxToBounds, projectBounds, levelLines, gridMarks, formatLevelElevation,
  type ViewFrame, type P2,
} from './viewGeometry.ts';

const CUT_COLOR = '#1f2937';

interface Extents {
  r: [number, number];      // screen-x (p·right)
  z: [number, number];      // elevation
  depth: [number, number];  // p·dir of the visible model
}

/** model (screen-x r, depth d, elevation z) → three world */
function worldAt(f: ViewFrame, r: number, d: number, z: number): Vector3 {
  const x = f.right.x * r + f.dir.x * d;
  const y = f.right.y * r + f.dir.y * d;
  return new Vector3(x, z, -y);
}

function resolveElementId(hit: Intersection): string | null {
  let obj: Object3D | null = hit.object;
  while (obj) {
    if (obj.userData.indexToId && hit.instanceId !== undefined) return obj.userData.indexToId[hit.instanceId] ?? null;
    if (obj.userData.faceToId && hit.faceIndex != null) return obj.userData.faceToId[hit.faceIndex] || null;
    if (obj.userData.elementId) return obj.userData.elementId as string;
    obj = obj.parent;
  }
  return null;
}

interface Bridge {
  frame: ViewFrame | null;
  extents: Extents | null;
  svg: SVGSVGElement | null;
}

function Scene({ view, bridge }: { view: OpenView; bridge: Bridge }) {
  const state = useCoreEditorState();
  const { project, grids } = state;
  const gl = useThree(s => s.gl);
  const camera = useThree(s => s.camera) as OrthographicCamera;
  const size = useThree(s => s.size);
  const invalidate = useThree(s => s.invalidate);
  const controls = useThree(s => s.controls) as OrbitControlsImpl | null;
  const modelRef = useRef<Group>(null);

  const frame = useMemo(() => viewFrame(view, project?.sections ?? []), [view, project?.sections]);
  bridge.frame = frame;
  const planes = useMemo(() => (frame?.planes ?? []).map(p => {
    const w = toWorldPlane(p);
    return new Plane(new Vector3(...w.normal), w.constant);
  }), [frame]);
  // Caps on the cut plane only; crop / depth planes trim them like the model.
  const capPlanes = useMemo(() => (view.kind === 'section' && planes.length ? [planes[0]] : []), [view.kind, planes]);

  // Section cut + crop planes for this renderer only.
  useEffect(() => {
    gl.localClippingEnabled = true;
    gl.clippingPlanes = planes;
    invalidate();
    return () => { gl.clippingPlanes = []; };
  }, [planes, gl, invalidate]);

  // Fit the camera to the building whenever the view (not the model) changes.
  const fittedFor = useRef('');
  const fit = useCallback((): boolean => {
    if (!frame || !modelRef.current || !controls || size.width === 0) return false;
    const box = visibleBox(modelRef.current);
    if (!box) return false;
    const b = worldBoxToBounds(box.min, box.max);
    const r = frame.crop ?? projectBounds(b, frame.right);
    const depthAxis = projectBounds(b, frame.dir);
    const levels = (project?.levels ?? []).map(l => l.elevation);
    const z: [number, number] = [Math.min(b.minZ, ...levels), Math.max(b.maxZ, ...levels)];
    bridge.extents = { r, z, depth: depthAxis };
    // Pixel margins: level heads on the right, grid bubbles on top.
    const M = { left: 24, right: 150, top: 56, bottom: 28 };
    const zoom = Math.max(0.5, Math.min(
      (size.width - M.left - M.right) / Math.max(r[1] - r[0], 1),
      (size.height - M.top - M.bottom) / Math.max(z[1] - z[0], 1)));
    const rc = (r[0] + r[1]) / 2 + (M.right - M.left) / 2 / zoom;
    const zc = (z[0] + z[1]) / 2 + (M.top - M.bottom) / 2 / zoom;
    // Stand well in front of everything, looking along the view direction.
    const near = (frame.cutDepth ?? depthAxis[0]) - 200;
    const pos = worldAt(frame, rc, near, zc);
    const target = worldAt(frame, rc, near + 1, zc);
    camera.position.copy(pos);
    camera.up.set(0, 1, 0);
    camera.near = 0.1;
    camera.far = 200 + (depthAxis[1] - depthAxis[0]) + 400;
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    camera.lookAt(target);
    controls.update();
    invalidate();
    return true;
  }, [frame, controls, size.width, size.height, camera, project?.levels, bridge, invalidate]);

  const key = view.kind === 'section' ? `s:${view.id}:${frame?.cutDepth}:${frame?.crop?.join(',')}` : `e:${view.dir}`;
  useEffect(() => {
    if (fittedFor.current === key) return;
    if (fit()) { fittedFor.current = key; return; }
    const t = setInterval(() => { if (fit()) { fittedFor.current = key; clearInterval(t); } }, 200);
    return () => clearInterval(t);
  }, [key, fit]);
  useEffect(() => {
    const onFit = () => { fit(); };
    window.addEventListener('zoom-to-fit-view', onFit);
    return () => window.removeEventListener('zoom-to-fit-view', onFit);
  }, [fit]);

  // Level lines, level heads and grid bubbles: projected each rendered frame.
  const levels = useMemo(() => levelLines(project?.levels ?? []), [project?.levels]);

  useFrame(() => {
    const svg = bridge.svg;
    const ext = bridge.extents;
    if (!svg || !frame || !ext) return;
    svg.style.visibility = '';
    const d = frame.cutDepth ?? ext.depth[0];
    const toScreen = (r: number, z: number): P2 => {
      const v = worldAt(frame, r, d, z).project(camera);
      return { x: (v.x * 0.5 + 0.5) * size.width, y: (-v.y * 0.5 + 0.5) * size.height };
    };
    const span = ext.r[1] - ext.r[0];
    const pad = Math.max(1, span * 0.04);
    svg.querySelectorAll<SVGGElement>('g[data-level]').forEach(g => {
      const lv = levels.find(l => l.id === g.dataset.level);
      if (!lv) return;
      const a = toScreen(ext.r[0] - pad, lv.elevation);
      const b = toScreen(ext.r[1] + pad, lv.elevation);
      const line = g.querySelector('line')!;
      line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
      g.querySelector('g')!.setAttribute('transform', `translate(${b.x},${b.y})`);
    });
    const zTop = ext.z[1] + 1.2, zBot = ext.z[0] - 0.6;
    const marks = gridMarks(grids, frame, d);
    svg.querySelectorAll<SVGGElement>('g[data-grid]').forEach(g => {
      const m = marks.find(x => x.id === g.dataset.grid);
      const outside = !m || (frame.crop && (m.at < frame.crop[0] - 0.01 || m.at > frame.crop[1] + 0.01));
      g.style.display = outside ? 'none' : '';
      if (!m || outside) return;
      const top = toScreen(m.at, zTop), bot = toScreen(m.at, zBot);
      const line = g.querySelector('line')!;
      line.setAttribute('x1', String(top.x)); line.setAttribute('y1', String(top.y));
      line.setAttribute('x2', String(bot.x)); line.setAttribute('y2', String(bot.y));
      g.querySelector('g')!.setAttribute('transform', `translate(${top.x},${top.y})`);
    });
  });

  useEffect(() => { invalidate(); }, [levels, grids, invalidate]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <hemisphereLight args={['#eef2f7', '#9aa4b0', 0.5]} />
      <directionalLight position={[40, 80, 60]} intensity={1.1} />
      <directionalLight position={[-50, 30, -40]} intensity={0.45} />
      <group ref={modelRef}>
        <FloorGroup allFloors />
      </group>
      <SectionCaps rootRef={modelRef} planes={capPlanes} color={CUT_COLOR}
        deps={[project, state.document, state.documentVersion, state.visibleLayers, state.activeDiscipline, state.showArchContext]} />
    </>
  );
}

function Interaction({ onPick }: { onPick: (id: string | null, additive: boolean) => void }) {
  const gl = useThree(s => s.gl);
  const camera = useThree(s => s.camera);
  const scene = useThree(s => s.scene);
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const rect = el.getBoundingClientRect();
      const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new Raycaster();
      ray.setFromCamera(ndc, camera);
      ray.params.Line = { threshold: 0.2 };
      for (const hit of ray.intersectObjects(scene.children, true)) {
        if (!isPointVisible(hit.point, gl.clippingPlanes)) continue;
        let o: Object3D | null = hit.object, hidden = false;
        while (o) { if (!o.visible) { hidden = true; break; } o = o.parent; }
        if (hidden) continue;
        const id = resolveElementId(hit);
        if (id) { onPick(id, e.shiftKey); return; }
      }
      onPick(null, e.shiftKey);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => { el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp); };
  }, [gl, camera, scene, onPick]);
  return null;
}

export default function OrthoView({ view }: { view: OpenView }) {
  const state = useCoreEditorState();
  const dispatch = useEditorDispatch();
  const [bridge] = useState<Bridge>(() => ({ frame: null, extents: null, svg: null }));
  const levels = useMemo(() => levelLines(state.project?.levels ?? []), [state.project?.levels]);
  const frame = useMemo(() => viewFrame(view, state.project?.sections ?? []), [view, state.project?.sections]);
  const marks = useMemo(() => {
    if (!frame) return [];
    return gridMarks(state.grids, frame, frame.cutDepth ?? 0);
  }, [state.grids, frame]);

  const currentLevel = state.currentLevel;
  // Pick in the pane = select in the plan: switch the plan to the element's
  // level first so its SelectionOverlay can draw it.
  const onPick = useCallback((id: string | null, additive: boolean) => {
    if (!id) { if (!additive) dispatch({ type: 'CLEAR_SELECTION' }); return; }
    const lv = toLevelId(id);
    if (lv && lv !== 'global' && lv !== currentLevel && !additive) dispatch({ type: 'SET_LEVEL', levelId: lv });
    dispatch({ type: 'SELECT', ids: [id], additive });
  }, [dispatch, currentLevel]);

  return (
    <div className="relative h-full w-full" data-testid="ortho-view">
      <Canvas
        orthographic
        frameloop="demand"
        camera={{ position: [0, 0, 100], zoom: 10, near: 0.1, far: 5000 }}
        gl={{ antialias: true, toneMapping: 4 }}
      >
        <color attach="background" args={['#f8fafc']} />
        <OrbitControls
          makeDefault
          enableRotate={false}
          enableDamping={false}
          screenSpacePanning
          zoomToCursor
          mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN }}
        />
        <Scene view={view} bridge={bridge} />
        <Interaction onPick={onPick} />
      </Canvas>
      <svg
        ref={el => { bridge.svg = el; }}
        className="pointer-events-none absolute inset-0 h-full w-full overflow-hidden"
        style={{ fontFamily: 'inherit', visibility: 'hidden' }}
      >
        {marks.map(m => (
          <g key={m.id} data-grid={m.id}>
            <line stroke="#94a3b8" strokeWidth={1} strokeDasharray="10 3 2 3" />
            <g>
              <circle cy={-11} r={10} fill="white" stroke="#64748b" strokeWidth={1.2} />
              <text y={-11} textAnchor="middle" dominantBaseline="central" fontSize={10} fill="#334155" fontWeight={600}>{m.number}</text>
            </g>
          </g>
        ))}
        {levels.map(l => (
          <g key={l.id} data-level={l.id}>
            <line stroke="#2563eb" strokeWidth={1} strokeDasharray="12 4" opacity={0.85} />
            <g>
              <path d="M0,0 L-6,-7 L6,-7 Z" fill="#2563eb" />
              <text x={10} y={-9} fontSize={10.5} fill="#1e3a8a" fontWeight={600}>{l.name}</text>
              <text x={10} y={4} fontSize={10} fill="#1e40af" dominantBaseline="hanging">{formatLevelElevation(l.elevation)}</text>
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
}
