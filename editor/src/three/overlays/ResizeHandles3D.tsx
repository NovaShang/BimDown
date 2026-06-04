import { useRef, useCallback } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { Billboard, Html, Line } from '@react-three/drei';
import { Plane, Vector2, Vector3, type Group, type PerspectiveCamera, type OrthographicCamera } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { CanonicalElement, Point, LineElement, SpatialLineElement } from '../../model/elements.ts';
import { useEditorDispatch, useEditorState } from '../../state/EditorContext.tsx';
import { snapPoint } from '../../utils/snap.ts';
import { arcFromMidpoint, arcMidpoint, tessellateArc } from '../../geometry/arc.ts';
import { formatLength, getProjectUnits } from '../../utils/units.ts';
import { supportsArcEdit } from '../../elements/registry.ts';
import type { ProjectUnit } from '../../types.ts';

function LengthLabel3D({ from, to, midY, projectUnit }: { from: Point; to: Point; midY: number; projectUnit: ProjectUnit }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return null;

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const nx = -dy / len;
  const ny = dx / len;
  const offset = 0.3;

  return (
    <Html
      position={[mx + nx * offset, midY + 0.15, -(my + ny * offset)]}
      style={{
        color: '#4fc3f7',
        fontSize: '11px',
        fontFamily: 'monospace',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        textShadow: '0 0 3px rgba(0,0,0,0.5)',
      }}
      center
    >
      {formatLength(len, projectUnit)}
    </Html>
  );
}

interface ResizeHandles3DProps {
  element: CanonicalElement;
  elevation: number;
  screenToSvg: (clientX: number, clientY: number) => { x: number; y: number } | null;
  resizeDraggingRef: React.RefObject<boolean>;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

const HANDLE_SIZE = 0.15;
const HANDLE_COLOR = '#06b6d4';
// On-screen radius (CSS px) of a HANDLE_SIZE handle. Handles are scaled per
// frame to hold this pixel size regardless of camera distance / zoom.
const HANDLE_PX = 7;

export default function ResizeHandles3D({ element, elevation, screenToSvg, resizeDraggingRef, controlsRef }: ResizeHandles3DProps) {
  const dispatch = useEditorDispatch();
  const state = useEditorState();
  const stateRef = useRef(state);
  stateRef.current = state;
  const beforeRef = useRef<CanonicalElement | null>(null);
  const { gl, camera, raycaster } = useThree();
  const projectUnit = getProjectUnits(state);

  const snapModelPoint = useCallback((clientX: number, clientY: number) => {
    const raw = screenToSvg(clientX, clientY);
    if (!raw) return null;
    const elements = stateRef.current.document?.elements ?? null;
    const exclude = new Set([element.id]);
    const grids = stateRef.current.grids;
    const snap = snapPoint(raw, screenToSvg, elements, exclude, undefined, undefined, grids, undefined, undefined, getProjectUnits(stateRef.current), stateRef.current.disabledSnapTypes);
    return snap.point;
  }, [element.id, screenToSvg]);

  /** Project the pointer onto a vertical plane through `anchorXY` (normal
   *  facing the camera horizontally) and return the world-space Y of the
   *  intersection. Used for Shift-drag to raise / lower a pipe endpoint. */
  const verticalDragWorldY = useCallback((clientX: number, clientY: number, anchorXY: Point): number | null => {
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    // anchor world position: model (x, y) → three (x, _, -y). Y is free since
    // the plane is vertical, so any Y works as a coplanar point.
    const anchorWorld = new Vector3(anchorXY.x, 0, -anchorXY.y);
    const normal = new Vector3(camera.position.x - anchorWorld.x, 0, camera.position.z - anchorWorld.z);
    if (normal.lengthSq() < 1e-6) return null;
    normal.normalize();
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, anchorWorld);
    const hit = new Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return hit.y;
  }, [gl, camera, raycaster]);

  const handleDrag = useCallback((
    onMove: (x: number, y: number) => void,
  ) => {
    return (e: React.PointerEvent) => {
      e.stopPropagation();
      const canvas = gl.domElement;
      canvas.setPointerCapture(e.pointerId);
      resizeDraggingRef.current = true;
      if (controlsRef.current) controlsRef.current.enabled = false;

      beforeRef.current = stateRef.current.document?.elements.get(element.id) ?? null;

      const moveHandler = (me: PointerEvent) => {
        const pt = snapModelPoint(me.clientX, me.clientY);
        if (pt) onMove(pt.x, pt.y);
      };

      const upHandler = () => {
        canvas.removeEventListener('pointermove', moveHandler);
        canvas.removeEventListener('pointerup', upHandler);
        canvas.releasePointerCapture(e.pointerId);
        resizeDraggingRef.current = false;
        if (controlsRef.current) controlsRef.current.enabled = true;
        if (beforeRef.current) {
          const after = stateRef.current.document?.elements.get(element.id) ?? null;
          dispatch({
            type: 'COMMIT_PREVIEW',
            description: 'Resize element',
            before: new Map([[element.id, beforeRef.current]]),
            after: new Map([[element.id, after]]),
          });
        }
        beforeRef.current = null;
      };

      canvas.addEventListener('pointermove', moveHandler);
      canvas.addEventListener('pointerup', upHandler);
    };
  }, [gl, snapModelPoint, element.id, dispatch]);

  /** Drag handler for an MEP / spatial-line endpoint with two modes:
   *   - default:   move in the horizontal plane (change x/y)
   *   - Shift held: move vertically (change startZ / endZ)
   *  Read live from `me.shiftKey` each move so the user can toggle mid-drag. */
  const handleEndpointDrag = useCallback((side: 'start' | 'end', elev: number) => {
    return (e: React.PointerEvent) => {
      e.stopPropagation();
      const canvas = gl.domElement;
      canvas.setPointerCapture(e.pointerId);
      resizeDraggingRef.current = true;
      if (controlsRef.current) controlsRef.current.enabled = false;
      beforeRef.current = stateRef.current.document?.elements.get(element.id) ?? null;

      const moveHandler = (me: PointerEvent) => {
        const cur = stateRef.current.document?.elements.get(element.id);
        if (!cur || (cur.geometry !== 'line' && cur.geometry !== 'spatial_line')) return;
        const ln = cur as LineElement | SpatialLineElement;
        const anchorXY = side === 'start' ? ln.start : ln.end;

        if (me.shiftKey && cur.geometry === 'spatial_line') {
          // Vertical mode: keep x/y, change Z from the pointer's height on a
          // camera-facing vertical plane.
          const wy = verticalDragWorldY(me.clientX, me.clientY, anchorXY);
          if (wy == null) return;
          const z = Math.round((wy - elev) * 1000) / 1000;
          dispatch({
            type: 'RESIZE_ELEMENT', id: element.id, preview: true,
            changes: side === 'start'
              ? { startZ: z, attrs: { start_z: String(z) } }
              : { endZ: z, attrs: { end_z: String(z) } },
          });
        } else {
          // Horizontal mode: keep Z, move in plan.
          const pt = snapModelPoint(me.clientX, me.clientY);
          if (!pt) return;
          dispatch({
            type: 'RESIZE_ELEMENT', id: element.id, preview: true,
            changes: side === 'start' ? { start: { x: pt.x, y: pt.y } } : { end: { x: pt.x, y: pt.y } },
          });
        }
      };

      const upHandler = () => {
        canvas.removeEventListener('pointermove', moveHandler);
        canvas.removeEventListener('pointerup', upHandler);
        canvas.releasePointerCapture(e.pointerId);
        resizeDraggingRef.current = false;
        if (controlsRef.current) controlsRef.current.enabled = true;
        if (beforeRef.current) {
          const after = stateRef.current.document?.elements.get(element.id) ?? null;
          dispatch({
            type: 'COMMIT_PREVIEW',
            description: 'Resize element',
            before: new Map([[element.id, beforeRef.current]]),
            after: new Map([[element.id, after]]),
          });
        }
        beforeRef.current = null;
      };

      canvas.addEventListener('pointermove', moveHandler);
      canvas.addEventListener('pointerup', upHandler);
    };
  }, [gl, snapModelPoint, verticalDragWorldY, element.id, dispatch, resizeDraggingRef, controlsRef]);

  if (element.geometry === 'line' || element.geometry === 'spatial_line') {
    const lineEl = element as LineElement | SpatialLineElement;

    // Follow the element's real Z. Mirror mepLineGeometry's Z resolution so the
    // handles sit on the actual centerline. Walls / plain lines have no per-end
    // Z → both ends fall back to base_offset, keeping handles at the wall base.
    const baseOffset = parseFloat(lineEl.attrs.base_offset || '0') || 0;
    let startZ = baseOffset, endZ = baseOffset;
    if (element.geometry === 'spatial_line') {
      const sp = element as SpatialLineElement;
      startZ = sp.startZ; endZ = sp.endZ;
    } else {
      startZ = parseFloat(lineEl.attrs.start_z || `${baseOffset}`) || baseOffset;
      endZ = parseFloat(lineEl.attrs.end_z || `${baseOffset}`) || baseOffset;
    }
    const startY = elevation + startZ;
    const endY = elevation + endZ;
    const midY = (startY + endY) / 2;

    const startPos: [number, number, number] = [element.start.x, startY, -element.start.y];
    const endPos: [number, number, number] = [element.end.x, endY, -element.end.y];

    const centerlinePoints: [number, number, number][] = lineEl.arc
      ? tessellateArc(lineEl.start, lineEl.end, lineEl.arc, 0.2).map((p, i, arr) => {
          const t = arr.length > 1 ? i / (arr.length - 1) : 0;
          return [p.x, startY + (endY - startY) * t, -p.y] as [number, number, number];
        })
      : [startPos, endPos];

    const mid = lineEl.arc
      ? arcMidpoint(lineEl.start, lineEl.end, lineEl.arc)
      : { x: (lineEl.start.x + lineEl.end.x) / 2, y: (lineEl.start.y + lineEl.end.y) / 2 };
    const midPos: [number, number, number] = [mid.x, midY, -mid.y];

    return (
      <group>
        <Line points={centerlinePoints} color={HANDLE_COLOR} lineWidth={2} dashed dashSize={0.2} gapSize={0.1} depthTest={false} renderOrder={998} />
        <HandleSphere position={startPos} onPointerDown={handleEndpointDrag('start', elevation)} />
        <HandleSphere position={endPos} onPointerDown={handleEndpointDrag('end', elevation)} />
        {supportsArcEdit(element.tableName) && (
          <HandleSphere position={midPos} color={lineEl.arc ? '#f59e0b' : HANDLE_COLOR} size={HANDLE_SIZE * 0.75}
            onPointerDown={handleDrag((x, yy) => {
              const newArc = arcFromMidpoint(lineEl.start, lineEl.end, { x, y: yy });
              dispatch({ type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes: { arc: newArc } });
            })} />
        )}
        <LengthLabel3D from={element.start} to={element.end} midY={midY} projectUnit={projectUnit} />
      </group>
    );
  }

  if (element.geometry === 'point') {
    const { position, width, height, attrs } = element;
    const y = elevation + (parseFloat(attrs.base_offset || '0') || 0);
    const hw = width / 2;
    const hh = height / 2;
    const rotDeg = parseFloat(attrs.rotation || '0');
    const rotRad = -rotDeg * Math.PI / 180; // negate: model Y maps to -Z in Three.js
    const cos = Math.cos(rotRad);
    const sin = Math.sin(rotRad);

    const rotateCorner = (lx: number, ly: number) => ({
      x: position.x + lx * cos - ly * sin,
      y: position.y + lx * sin + ly * cos,
    });

    const corners = [
      rotateCorner(-hw, -hh),
      rotateCorner(hw, -hh),
      rotateCorner(hw, hh),
      rotateCorner(-hw, hh),
    ];
    const outlinePoints: [number, number, number][] = [
      ...corners.map(c => [c.x, y, -c.y] as [number, number, number]),
      [corners[0].x, y, -corners[0].y],
    ];

    return (
      <group>
        <Line points={outlinePoints} color={HANDLE_COLOR} lineWidth={2} depthTest={false} renderOrder={998} />
        {corners.map((c, i) => (
          <HandleSphere
            key={i}
            position={[c.x, y, -c.y]}
            onPointerDown={handleDrag((x, yy) => {
              const opposite = corners[(i + 2) % 4];
              const newW = Math.max(Math.abs(x - opposite.x), 0.05);
              const newH = Math.max(Math.abs(yy - opposite.y), 0.05);
              dispatch({
                type: 'RESIZE_ELEMENT',
                id: element.id,
                preview: true,
                changes: { position: { x: (x + opposite.x) / 2, y: (yy + opposite.y) / 2 }, width: newW, height: newH },
              });
            })}
          />
        ))}
      </group>
    );
  }

  if (element.geometry === 'polygon') {
    const y = elevation + (parseFloat(element.attrs.base_offset || '0') || 0);
    const outlinePoints: [number, number, number][] = element.vertices.length > 0
      ? [...element.vertices.map(v => [v.x, y, -v.y] as [number, number, number]), [element.vertices[0].x, y, -element.vertices[0].y]]
      : [];

    return (
      <group>
        {outlinePoints.length > 1 && (
          <Line points={outlinePoints} color={HANDLE_COLOR} lineWidth={2} depthTest={false} renderOrder={998} />
        )}
        {element.vertices.map((v, i) => (
          <HandleSphere
            key={i}
            position={[v.x, y, -v.y]}
            onPointerDown={handleDrag((x, yy) => {
              const newVertices = [...element.vertices];
              newVertices[i] = { x, y: yy };
              dispatch({ type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes: { vertices: newVertices } });
            })}
          />
        ))}
      </group>
    );
  }

  return null;
}

function HandleSphere({ position, onPointerDown, color, size }: {
  position: [number, number, number];
  onPointerDown: (e: React.PointerEvent) => void;
  color?: string;
  size?: number;
}) {
  const s = size ?? HANDLE_SIZE;
  const c = color ?? HANDLE_COLOR;
  const ref = useRef<Group>(null);
  const { camera, size: viewport } = useThree();

  // Keep a constant on-screen size: scale the handle by the world units that
  // map to one CSS pixel at this distance, so it neither grows when zooming in
  // nor shrinks when zooming out. Mid handles keep their relative geometry size
  // because the scale factor is independent of `s`.
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const dist = Math.hypot(
      camera.position.x - position[0],
      camera.position.y - position[1],
      camera.position.z - position[2],
    );
    let worldPerPixel: number;
    if ((camera as PerspectiveCamera).isPerspectiveCamera) {
      const vFov = ((camera as PerspectiveCamera).fov * Math.PI) / 180;
      worldPerPixel = (2 * Math.tan(vFov / 2) * dist) / viewport.height;
    } else {
      const ortho = camera as OrthographicCamera;
      worldPerPixel = (ortho.top - ortho.bottom) / (ortho.zoom * viewport.height);
    }
    g.scale.setScalar((HANDLE_PX / HANDLE_SIZE) * worldPerPixel);
  });

  return (
    <group ref={ref} position={position}>
      <Billboard renderOrder={999}>
        <mesh onPointerDown={onPointerDown} raycast={undefined}>
          <circleGeometry args={[s, 24]} />
          <meshBasicMaterial color={c} depthTest={false} depthWrite={false} transparent />
        </mesh>
        <mesh raycast={undefined}>
          <ringGeometry args={[s, s + 0.03, 24]} />
          <meshBasicMaterial color="white" depthTest={false} depthWrite={false} transparent />
        </mesh>
      </Billboard>
    </group>
  );
}
