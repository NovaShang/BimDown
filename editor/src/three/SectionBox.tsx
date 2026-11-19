/**
 * 3D section box: six renderer clipping planes + an on-screen gizmo.
 *
 * Clipping uses `renderer.clippingPlanes` rather than per-material planes: the
 * element materials are cached and shared with the elevation/section pane's
 * canvas, so per-material planes would leak into the other view. Renderer planes
 * apply to every material (instanced and merged batches alike) of this canvas only.
 *
 * The gizmo is DOM/SVG over the canvas, so the clipping never trims it and its
 * handles take pointer events before OrbitControls sees them.
 */
import { useEffect, useRef, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Box3, Vector3, type Camera, type InstancedMesh, type Object3D, type BufferGeometry, Matrix4 } from 'three';
import { useEditorState, useEditorDispatch } from '../state/EditorContext.tsx';
import type { SectionBoxBounds } from '../views/viewTypes.ts';
import { worldBoxToBounds } from '../views/viewGeometry.ts';
import { visibleBox } from './cameraFit.ts';

export interface SectionBoxBridge {
  camera: Camera | null;
  width: number;
  height: number;
  /** Bounds currently drawn (live while a face is dragged). */
  bounds: SectionBoxBounds | null;
  /** Registered by the clipping controller: move the planes without a state update. */
  applyLive: ((b: SectionBoxBounds) => void) | null;
  svg: SVGSVGElement | null;
  /** A face is being dragged: caps are stale until the drop. */
  dragging: boolean;
}

export function createSectionBoxBridge(): SectionBoxBridge {
  return { camera: null, width: 0, height: 0, bounds: null, applyLive: null, svg: null, dragging: false };
}

const MIN_SIZE = 0.2;
const PAD = 0.25;

const toWorld = (x: number, y: number, z: number) => new Vector3(x, z, -y);

function corners(b: SectionBoxBounds): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(toWorld(i & 1 ? b.maxX : b.minX, i & 2 ? b.maxY : b.minY, i & 4 ? b.maxZ : b.minZ));
  }
  return out;
}
const EDGES: [number, number][] = [];
for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) EDGES.push([i, i | bit]);

type FaceKey = 'minX' | 'maxX' | 'minY' | 'maxY' | 'minZ' | 'maxZ';
const FACES: { key: FaceKey; axis: 'X' | 'Y' | 'Z'; color: string }[] = [
  { key: 'minX', axis: 'X', color: '#ef4444' }, { key: 'maxX', axis: 'X', color: '#ef4444' },
  { key: 'minY', axis: 'Y', color: '#22c55e' }, { key: 'maxY', axis: 'Y', color: '#22c55e' },
  { key: 'minZ', axis: 'Z', color: '#3b82f6' }, { key: 'maxZ', axis: 'Z', color: '#3b82f6' },
];

function faceCenter(b: SectionBoxBounds, key: FaceKey): Vector3 {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, cz = (b.minZ + b.maxZ) / 2;
  switch (key) {
    case 'minX': return toWorld(b.minX, cy, cz);
    case 'maxX': return toWorld(b.maxX, cy, cz);
    case 'minY': return toWorld(cx, b.minY, cz);
    case 'maxY': return toWorld(cx, b.maxY, cz);
    case 'minZ': return toWorld(cx, cy, b.minZ);
    case 'maxZ': return toWorld(cx, cy, b.maxZ);
  }
}
/** World direction of increasing model X / Y / Z. */
const AXIS_WORLD = { X: new Vector3(1, 0, 0), Y: new Vector3(0, 0, -1), Z: new Vector3(0, 1, 0) };

function project(p: Vector3, bridge: SectionBoxBridge): { x: number; y: number; behind: boolean } {
  const v = p.clone().project(bridge.camera!);
  return { x: (v.x * 0.5 + 0.5) * bridge.width, y: (-v.y * 0.5 + 0.5) * bridge.height, behind: v.z > 1 || v.z < -1 };
}

/** Padded box of the visible model, trimmed to the shown floor range. */
export function modelSectionBounds(root: Object3D, zRange: [number, number] | null): SectionBoxBounds | null {
  const box = visibleBox(root);
  if (!box) return null;
  const b = worldBoxToBounds(box.min, box.max);
  if (zRange) { b.minZ = Math.max(b.minZ, zRange[0]); b.maxZ = Math.min(b.maxZ, zRange[1]); }
  return { minX: b.minX - PAD, maxX: b.maxX + PAD, minY: b.minY - PAD, maxY: b.maxY + PAD, minZ: b.minZ - PAD, maxZ: b.maxZ + PAD };
}

/** Padded box of the selected elements' geometry, or null when none is drawn. */
function selectionBounds(root: Object3D, ids: Set<string>): SectionBoxBounds | null {
  root.updateWorldMatrix(true, true);
  const box = new Box3();
  const part = new Box3();
  const m = new Matrix4();
  root.traverseVisible(o => {
    const geo = (o as Object3D & { geometry?: BufferGeometry }).geometry;
    if (!geo?.attributes?.position) return;
    const indexToId = o.userData.indexToId as string[] | undefined;
    let owner: Object3D | null = o;
    let id: string | undefined;
    while (owner && !id) { id = owner.userData.elementId; owner = owner.parent; }
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingBox) return;
    if (indexToId) {
      const inst = o as InstancedMesh;
      indexToId.forEach((iid, i) => {
        if (!ids.has(iid)) return;
        inst.getMatrixAt(i, m);
        box.union(part.copy(geo.boundingBox!).applyMatrix4(m).applyMatrix4(o.matrixWorld));
      });
    } else if (id && ids.has(id)) {
      box.union(part.copy(geo.boundingBox).applyMatrix4(o.matrixWorld));
    }
  });
  if (box.isEmpty()) return null;
  const b = worldBoxToBounds(box.min.toArray() as [number, number, number], box.max.toArray() as [number, number, number]);
  // Generous margin so the selection keeps some surrounding context.
  const pad = 1;
  return { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad, minZ: b.minZ - pad, maxZ: b.maxZ + pad };
}

/**
 * Inside the Canvas: fits the box the first time it is enabled, answers the
 * toolbar's fit-to-selection / reset events, and feeds the gizmo the camera.
 */
export function SectionBoxController({ modelRef, bridge, zRange }: {
  modelRef: React.RefObject<Object3D | null>;
  bridge: SectionBoxBridge;
  zRange: [number, number] | null;
}) {
  const { views, selectedIds } = useEditorState();
  const dispatch = useEditorDispatch();
  const camera = useThree(s => s.camera);
  const size = useThree(s => s.size);
  const { enabled, bounds } = views.sectionBox;
  const zRangeRef = useRef(zRange);
  zRangeRef.current = zRange;

  const reset = useCallback(() => {
    if (!modelRef.current) return false;
    const b = modelSectionBounds(modelRef.current, zRangeRef.current);
    if (b) dispatch({ type: 'SET_SECTION_BOX', enabled: true, bounds: b });
    return !!b;
  }, [modelRef, dispatch]);

  // First enable: fit the model (retry while the scene is still mounting).
  useEffect(() => {
    if (!enabled || bounds) return;
    if (reset()) return;
    const t = setInterval(() => { if (reset()) clearInterval(t); }, 250);
    return () => clearInterval(t);
  }, [enabled, bounds, reset]);

  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  useEffect(() => {
    const onReset = () => { reset(); };
    const onFit = () => {
      if (!modelRef.current) return;
      const b = selectionBounds(modelRef.current, selectedRef.current);
      if (!b) return;
      dispatch({ type: 'SET_SECTION_BOX', enabled: true, bounds: b });
      // Frame the camera on the new box once it is applied.
      setTimeout(() => window.dispatchEvent(new Event('zoom-to-fit-3d')), 50);
    };
    window.addEventListener('section-box-reset', onReset);
    window.addEventListener('section-box-fit', onFit);
    return () => {
      window.removeEventListener('section-box-reset', onReset);
      window.removeEventListener('section-box-fit', onFit);
    };
  }, [reset, modelRef, dispatch]);

  useEffect(() => { bridge.bounds = enabled ? bounds : null; }, [bridge, enabled, bounds]);

  // Every frame: project the box into the gizmo SVG (cheap: 8 corners, 6 faces).
  useFrame(() => {
    bridge.camera = camera;
    bridge.width = size.width;
    bridge.height = size.height;
    const svg = bridge.svg;
    if (!svg) return;
    const b = bridge.bounds;
    svg.style.display = b ? '' : 'none';
    if (!b) return;
    const pts = corners(b).map(p => project(p, bridge));
    const lines = svg.querySelectorAll<SVGLineElement>('line[data-edge]');
    EDGES.forEach(([i, j], k) => {
      const l = lines[k];
      if (!l) return;
      const hide = pts[i].behind || pts[j].behind;
      l.style.display = hide ? 'none' : '';
      l.setAttribute('x1', String(pts[i].x)); l.setAttribute('y1', String(pts[i].y));
      l.setAttribute('x2', String(pts[j].x)); l.setAttribute('y2', String(pts[j].y));
    });
    for (const f of FACES) {
      const g = svg.querySelector<SVGGElement>(`g[data-face="${f.key}"]`);
      if (!g) continue;
      const c = project(faceCenter(b, f.key), bridge);
      g.style.display = c.behind ? 'none' : '';
      g.setAttribute('transform', `translate(${c.x},${c.y})`);
    }
  });

  return null;
}

/** DOM gizmo: box edges and six draggable face handles (X red, Y green, Z blue). */
export function SectionBoxGizmo({ bridge }: { bridge: SectionBoxBridge }) {
  const { views } = useEditorState();
  const dispatch = useEditorDispatch();
  const drag = useRef<{ key: FaceKey; axis: 'X' | 'Y' | 'Z'; start: SectionBoxBounds; x: number; y: number; px: { x: number; y: number }; pointerId: number } | null>(null);

  const onDown = (e: React.PointerEvent, key: FaceKey, axis: 'X' | 'Y' | 'Z') => {
    const b = bridge.bounds;
    if (e.button !== 0 || !b || !bridge.camera) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    // Screen pixels per model unit along the face's axis.
    const c = faceCenter(b, key);
    const a = project(c, bridge);
    const p = project(c.clone().add(AXIS_WORLD[axis]), bridge);
    bridge.dragging = true;
    drag.current = { key, axis, start: { ...b }, x: e.clientX, y: e.clientY, px: { x: p.x - a.x, y: p.y - a.y }, pointerId: e.pointerId };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    const len2 = d.px.x * d.px.x + d.px.y * d.px.y;
    if (len2 < 1e-6) return;
    const units = ((e.clientX - d.x) * d.px.x + (e.clientY - d.y) * d.px.y) / len2;
    const b = { ...d.start };
    const lo = `min${d.axis}` as FaceKey, hi = `max${d.axis}` as FaceKey;
    if (d.key === lo) b[lo] = Math.min(d.start[lo] + units, b[hi] - MIN_SIZE);
    else b[hi] = Math.max(d.start[hi] + units, b[lo] + MIN_SIZE);
    bridge.bounds = b;
    bridge.applyLive?.(b);
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    bridge.dragging = false;
    if (bridge.bounds) dispatch({ type: 'SET_SECTION_BOX', bounds: { ...bridge.bounds } });
  };

  if (!views.sectionBox.enabled) return null;
  return (
    <svg
      ref={el => { bridge.svg = el; }}
      data-testid="section-box-gizmo"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', zIndex: 15, display: 'none' }}
    >
      {EDGES.map((_, k) => (
        <line key={k} data-edge={k} stroke="#f59e0b" strokeWidth={1.25} strokeDasharray="5 3" opacity={0.9} />
      ))}
      {FACES.map(f => (
        <g key={f.key} data-face={f.key} style={{ pointerEvents: 'auto', cursor: 'grab' }}
          onPointerDown={e => onDown(e, f.key, f.axis)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <circle r={11} fill="transparent" />
          <circle r={6} fill={f.color} stroke="white" strokeWidth={2} />
        </g>
      ))}
    </svg>
  );
}
