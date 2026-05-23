import { useCallback, useRef } from 'react';
import type { CanonicalElement, Point, LineElement, SpatialLineElement } from '../model/elements.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { snapPoint, type SnapResult } from '../utils/snap.ts';
import { arcFromMidpoint, arcMidpoint, arcLength } from '../geometry/arc.ts';
import { formatLength, getProjectUnits } from '../utils/units.ts';
import type { ProjectUnit } from '../types.ts';

function LengthLabel({ from, to, scale, length, projectUnit }: { from: Point; to: Point; scale: number; length?: number; projectUnit: ProjectUnit }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chordLen = Math.sqrt(dx * dx + dy * dy);
  const len = length ?? chordLen;
  if (chordLen < 1e-6) return null;

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const nx = -dy / chordLen;
  const ny = dx / chordLen;
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
      pointerEvents="none"
    >
      {formatLength(len, projectUnit)}
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
  const projectUnit = getProjectUnits(state);
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
    const unit = getProjectUnits(stateRef.current);
    const snap = snapPoint(raw, screenToSvg, elements, exclude, undefined, undefined, grids, undefined, undefined, unit);
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
    const lineEl = element as LineElement | SpatialLineElement;
    const arcHandleMid = lineEl.arc
      ? arcMidpoint(lineEl.start, lineEl.end, lineEl.arc)
      : { x: (lineEl.start.x + lineEl.end.x) / 2, y: (lineEl.start.y + lineEl.end.y) / 2 };
    const arcR = (HANDLE_RADIUS * 0.75) / scale;

    const displayLen = lineEl.arc
      ? arcLength(lineEl.start, lineEl.end, lineEl.arc)
      : Math.sqrt((lineEl.end.x - lineEl.start.x) ** 2 + (lineEl.end.y - lineEl.start.y) ** 2);

    return (
      <g className="resize-handles" transform="scale(1,-1)">
        <circle
          cx={element.start.x} cy={element.start.y}
          r={r} fill="#06b6d4" stroke="white" strokeWidth={sw}
          cursor="move"
          onPointerDown={handleDrag((x, y) => {
            dispatch({ type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes: { start: { x, y } } });
          })}
        />
        <circle
          cx={element.end.x} cy={element.end.y}
          r={r} fill="#06b6d4" stroke="white" strokeWidth={sw}
          cursor="move"
          onPointerDown={handleDrag((x, y) => {
            dispatch({ type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes: { end: { x, y } } });
          })}
        />
        {/* Arc midpoint handle */}
        <circle
          cx={arcHandleMid.x} cy={arcHandleMid.y}
          r={arcR}
          fill={lineEl.arc ? '#f59e0b' : '#06b6d4'} stroke="white" strokeWidth={sw}
          cursor="crosshair" opacity={0.9}
          onPointerDown={handleDrag((x, y) => {
            const newArc = arcFromMidpoint(lineEl.start, lineEl.end, { x, y });
            dispatch({ type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes: { arc: newArc } });
          })}
        />
        <LengthLabel from={element.start} to={element.end} scale={scale} length={displayLen} projectUnit={projectUnit} />
      </g>
    );
  }

  if (element.geometry === 'point') {
    // Spaces are conceptually a single named seed — no width/height to resize.
    // Render one move handle at the room label so the affordance lands on the
    // visible text rather than at an empty bbox center. The name label is
    // drawn 0.45m below the seed in space.draw2D; mirror that offset here so
    // the handle visually coincides with whichever label is showing.
    if (element.tableName === 'space') {
      const { position } = element;
      const NAME_LABEL_OFFSET = 0.45;
      const handleY = element.attrs.name ? position.y - NAME_LABEL_OFFSET : position.y;
      return (
        <g className="resize-handles" transform="scale(1,-1)">
          <circle
            cx={position.x} cy={handleY}
            r={r * 1.3}
            fill="#06b6d4" stroke="white" strokeWidth={sw}
            cursor="move"
            onPointerDown={handleDrag((x, y) => {
              // Convert the dragged handle coord back to the seed by undoing the
              // label offset so the underlying position tracks the cursor 1:1.
              const seedY = element.attrs.name ? y + NAME_LABEL_OFFSET : y;
              dispatch({
                type: 'RESIZE_ELEMENT', id: element.id, preview: true,
                changes: { position: { x, y: seedY } },
              });
            })}
          />
        </g>
      );
    }
    const { position, width, height, attrs } = element;
    const hw = width / 2;
    const hh = height / 2;
    const rotDeg = parseFloat(attrs.rotation || '0');
    const rotRad = rotDeg * Math.PI / 180;
    const cos = Math.cos(rotRad);
    const sin = Math.sin(rotRad);

    // Rotate a local offset around the element center
    const rotateCorner = (lx: number, ly: number) => ({
      x: position.x + lx * cos - ly * sin,
      y: position.y + lx * sin + ly * cos,
    });

    const localCorners = [
      { lx: -hw, ly: -hh },
      { lx: hw, ly: -hh },
      { lx: hw, ly: hh },
      { lx: -hw, ly: hh },
    ];
    const corners = localCorners.map(c => rotateCorner(c.lx, c.ly));

    return (
      <g className="resize-handles" transform="scale(1,-1)">
        {corners.map((c, i) => (
          <circle
            key={i}
            cx={c.x} cy={c.y}
            r={r}
            fill="#06b6d4" stroke="white" strokeWidth={sw}
            cursor="move"
            onPointerDown={handleDrag((x, y) => {
              // Project dragged point back to local space to compute new size
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
            fill="#06b6d4" stroke="white" strokeWidth={sw}
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
