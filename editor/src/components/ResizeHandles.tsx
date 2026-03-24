import { useCallback, useRef } from 'react';
import type { CanonicalElement, Point } from '../model/elements.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { snapPoint, type SnapResult } from '../utils/snap.ts';

function formatLength(meters: number): string {
  if (meters < 1) return `${(meters * 1000).toFixed(0)} mm`;
  return `${meters.toFixed(3)} m`;
}

function LengthLabel({ from, to, scale }: { from: Point; to: Point; scale: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return null;

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const nx = -dy / len;
  const ny = dx / len;
  const offset = 0.8 / scale;
  const fontSize = 1.0 / scale;

  const lx = mx + nx * offset;
  const ly = my + ny * offset;

  return (
    <text
      x={lx} y={-ly}
      fill="#4fc3f7"
      fontSize={fontSize}
      fontFamily="monospace"
      textAnchor="middle"
      transform="scale(1,-1)"
      opacity={0.9}
    >
      {formatLength(len)}
    </text>
  );
}

interface ResizeHandlesProps {
  element: CanonicalElement;
  svgRef: React.RefObject<SVGSVGElement | null>;
  scale: number;
  onSnap?: (snap: SnapResult | null) => void;
}

const HANDLE_RADIUS = 0.36;

export default function ResizeHandles({ element, svgRef, scale, onSnap }: ResizeHandlesProps) {
  const r = HANDLE_RADIUS / scale;
  const sw = 0.09 / scale;

  const dispatch = useEditorDispatch();
  const state = useEditorState();
  const stateRef = useRef(state);
  stateRef.current = state;
  const beforeRef = useRef<CanonicalElement | null>(null);

  const screenToSvg = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const svgPt = pt.matrixTransform(ctm.inverse());
    return { x: svgPt.x, y: -svgPt.y };
  }, [svgRef]);

  const snapSvgPoint = useCallback((clientX: number, clientY: number) => {
    const raw = screenToSvg(clientX, clientY);
    if (!raw) return null;
    const elements = stateRef.current.document?.elements ?? null;
    const exclude = new Set([element.id]);
    const grids = stateRef.current.grids;
    const snap = snapPoint(raw, screenToSvg, elements, exclude, undefined, undefined, grids);
    onSnap?.(snap.snapX || snap.snapY ? snap : null);
    return snap.point;
  }, [screenToSvg, element.id, onSnap]);

  const handleDrag = useCallback((
    onMove: (svgX: number, svgY: number) => void,
  ) => {
    return (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const target = e.currentTarget as SVGElement;
      target.setPointerCapture(e.pointerId);

      // Snapshot before drag starts
      beforeRef.current = stateRef.current.document?.elements.get(element.id) ?? null;

      const moveHandler = (me: PointerEvent) => {
        const pt = snapSvgPoint(me.clientX, me.clientY);
        if (pt) onMove(pt.x, pt.y);
      };

      const upHandler = () => {
        target.removeEventListener('pointermove', moveHandler);
        target.removeEventListener('pointerup', upHandler);
        // Commit single undo entry
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
        onSnap?.(null);
      };

      target.addEventListener('pointermove', moveHandler);
      target.addEventListener('pointerup', upHandler);
    };
  }, [snapSvgPoint, element.id, dispatch, onSnap]);

  if (element.geometry === 'line' || element.geometry === 'spatial_line') {
    return (
      <g className="resize-handles" transform="scale(1,-1)">
        {/* Start endpoint */}
        <circle
          cx={element.start.x} cy={element.start.y}
          r={r}
          fill="#0d99ff" stroke="white" strokeWidth={sw}
          cursor="move"
          onPointerDown={handleDrag((x, y) => {
            dispatch({
              type: 'RESIZE_ELEMENT',
              id: element.id,
              preview: true,
              changes: { start: { x, y } },
            });
          })}
        />
        {/* End endpoint */}
        <circle
          cx={element.end.x} cy={element.end.y}
          r={r}
          fill="#0d99ff" stroke="white" strokeWidth={sw}
          cursor="move"
          onPointerDown={handleDrag((x, y) => {
            dispatch({
              type: 'RESIZE_ELEMENT',
              id: element.id,
              preview: true,
              changes: { end: { x, y } },
            });
          })}
        />
        <LengthLabel from={element.start} to={element.end} scale={scale} />
      </g>
    );
  }

  if (element.geometry === 'point') {
    const { position, width, height } = element;
    const hw = width / 2;
    const hh = height / 2;
    const corners = [
      { x: position.x - hw, y: position.y - hh, cursor: 'nesw-resize' },
      { x: position.x + hw, y: position.y - hh, cursor: 'nwse-resize' },
      { x: position.x + hw, y: position.y + hh, cursor: 'nesw-resize' },
      { x: position.x - hw, y: position.y + hh, cursor: 'nwse-resize' },
    ];

    return (
      <g className="resize-handles" transform="scale(1,-1)">
        {corners.map((c, i) => (
          <circle
            key={i}
            cx={c.x} cy={c.y}
            r={r}
            fill="#0d99ff" stroke="white" strokeWidth={sw}
            cursor={c.cursor}
            onPointerDown={handleDrag((x, y) => {
              // Compute new position (center) and size based on which corner is dragged
              const opposite = corners[(i + 2) % 4];
              const newW = Math.max(Math.abs(x - opposite.x), 0.05);
              const newH = Math.max(Math.abs(y - opposite.y), 0.05);
              const centerX = (x + opposite.x) / 2;
              const centerY = (y + opposite.y) / 2;
              dispatch({
                type: 'RESIZE_ELEMENT',
                id: element.id,
                changes: {
                  position: { x: centerX, y: centerY },
                  width: newW,
                  height: newH,
                },
              });
            })}
          />
        ))}
      </g>
    );
  }

  if (element.geometry === 'polygon') {
    return (
      <g className="resize-handles" transform="scale(1,-1)">
        {element.vertices.map((v, i) => (
          <circle
            key={i}
            cx={v.x} cy={v.y}
            r={r}
            fill="#0d99ff" stroke="white" strokeWidth={sw}
            cursor="move"
            onPointerDown={handleDrag((x, y) => {
              const newVertices = [...element.vertices];
              newVertices[i] = { x, y };
              dispatch({
                type: 'RESIZE_ELEMENT',
                id: element.id,
                changes: { vertices: newVertices },
              });
            })}
          />
        ))}
      </g>
    );
  }

  return null;
}
