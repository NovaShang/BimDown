import { useRef, useCallback } from 'react';
import { useThree } from '@react-three/fiber';
import { Billboard, Html } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { CanonicalElement, Point } from '../../model/elements.ts';
import { useEditorDispatch, useEditorState } from '../../state/EditorContext.tsx';
import { snapPoint } from '../../utils/snap.ts';

function formatLength(meters: number): string {
  if (meters < 1) return `${(meters * 1000).toFixed(0)} mm`;
  return `${meters.toFixed(3)} m`;
}

function LengthLabel3D({ from, to, elevation }: { from: Point; to: Point; elevation: number }) {
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
      position={[mx + nx * offset, elevation + 0.15, -(my + ny * offset)]}
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
      {formatLength(len)}
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
const HANDLE_COLOR = '#0d99ff';

export default function ResizeHandles3D({ element, elevation, screenToSvg, resizeDraggingRef, controlsRef }: ResizeHandles3DProps) {
  const dispatch = useEditorDispatch();
  const state = useEditorState();
  const stateRef = useRef(state);
  stateRef.current = state;
  const beforeRef = useRef<CanonicalElement | null>(null);
  const { gl } = useThree();

  const snapModelPoint = useCallback((clientX: number, clientY: number) => {
    const raw = screenToSvg(clientX, clientY);
    if (!raw) return null;
    const elements = stateRef.current.document?.elements ?? null;
    const exclude = new Set([element.id]);
    const grids = stateRef.current.grids;
    const snap = snapPoint(raw, screenToSvg, elements, exclude, undefined, undefined, grids);
    return snap.point;
  }, [element.id, screenToSvg]);

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

  const y = elevation + 0.05;

  if (element.geometry === 'line' || element.geometry === 'spatial_line') {
    return (
      <group>
        <HandleSphere
          position={[element.start.x, y, -element.start.y]}
          onPointerDown={handleDrag((x, yy) => {
            dispatch({ type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes: { start: { x, y: yy } } });
          })}
        />
        <HandleSphere
          position={[element.end.x, y, -element.end.y]}
          onPointerDown={handleDrag((x, yy) => {
            dispatch({ type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes: { end: { x, y: yy } } });
          })}
        />
        <LengthLabel3D from={element.start} to={element.end} elevation={elevation} />
      </group>
    );
  }

  if (element.geometry === 'point') {
    const { position, width, height } = element;
    const hw = width / 2;
    const hh = height / 2;
    const corners = [
      { x: position.x - hw, y: position.y - hh },
      { x: position.x + hw, y: position.y - hh },
      { x: position.x + hw, y: position.y + hh },
      { x: position.x - hw, y: position.y + hh },
    ];

    return (
      <group>
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
    return (
      <group>
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

function HandleSphere({ position, onPointerDown }: {
  position: [number, number, number];
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <Billboard position={position} renderOrder={999}>
      <mesh onPointerDown={onPointerDown} raycast={undefined}>
        <circleGeometry args={[HANDLE_SIZE, 16]} />
        <meshBasicMaterial color={HANDLE_COLOR} depthTest={false} />
      </mesh>
      <mesh raycast={undefined}>
        <ringGeometry args={[HANDLE_SIZE, HANDLE_SIZE + 0.03, 16]} />
        <meshBasicMaterial color="white" depthTest={false} />
      </mesh>
    </Billboard>
  );
}
