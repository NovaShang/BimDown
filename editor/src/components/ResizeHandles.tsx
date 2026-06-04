import { useCallback, useRef } from 'react';
import type { CanonicalElement, Point, LineElement, SpatialLineElement, PointElement } from '../model/elements.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { snapPoint, type SnapResult } from '../utils/snap.ts';
import { arcFromMidpoint, arcMidpoint, arcLength } from '../geometry/arc.ts';
import { formatLength, getProjectUnits } from '../utils/units.ts';
import type { ProjectUnit } from '../types.ts';
import { getElementModule, supportsArcEdit } from '../elements/registry.ts';
import { useGeometryContext } from '../adapters/svg/context.tsx';
import { gatherConnectorSnapPoints, isMepLineTable } from '../utils/connectorSnap.ts';
import { findPipeBodyHit, type MepCurveElement } from '../utils/pipeBodyHit.ts';
import { generateId, toElementId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';

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
  // Connectors are pure derivatives of their host's position + local offset.
  // Their world position is recomputed each frame from `attrs.offset_*`, so
  // a position drag wouldn't actually persist; expose no handles at all and
  // route any canvas interaction through the host instead (see selectTool).
  if (element.tableName === 'connector') return null;
  const r = HANDLE_RADIUS / scale;
  const sw = 0.09 / scale;

  const dispatch = useEditorDispatch();
  const state = useEditorState();
  const stateRef = useRef(state);
  stateRef.current = state;
  const projectUnit = getProjectUnits(state);
  const beforeRef = useRef<CanonicalElement | null>(null);
  /** Pre-drag snapshot of elements hosted on this element (e.g. doors/windows
   *  embedded in a wall). The RESIZE_ELEMENT reducer re-resolves them as the
   *  host is dragged, so they must be recorded in the commit for undo. */
  const hostedBeforeRef = useRef<Map<string, CanonicalElement>>(new Map());
  /** Pointer position at the moment the current drag started. Custom handles
   *  read this so "translate" behavior can compute deltas without drift. */
  const dragStartRef = useRef<Point>({ x: 0, y: 0 });

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
    // MEP-curve endpoints get the same connector snap targets as the line
    // drawing tool, so dragging a pipe end onto an equipment port wires the
    // port_ref automatically (see `from`/`to` handling below).
    const connectorPoints = isMepLineTable(element.tableName)
      ? gatherConnectorSnapPoints(elements ?? undefined)
      : undefined;
    const snap = snapPoint(raw, screenToSvg, elements, exclude, undefined, undefined, grids, undefined, connectorPoints, unit, stateRef.current.disabledSnapTypes);
    onSnap?.(snap.snapX || snap.snapY ? snap : null);
    return snap;
  }, [screenToSvg, element.id, element.tableName, onSnap]);

  /** Side of a MEP-curve endpoint drag, captured by the pointer-down branch
   *  so the pointer-up handler can run a "did this drop into another pipe's
   *  body? if so, T-junction" check. */
  const endpointSideRef = useRef<'start' | 'end' | null>(null);
  /** Most recent snap result during the drag, so upHandler can read the
   *  final snap without an extra screenToSvg call. */
  const lastSnapRef = useRef<SnapResult | null>(null);

  const handleDrag = useCallback((
    onMove: (svgX: number, svgY: number, snap: SnapResult) => void,
    opts: { endpointSide?: 'start' | 'end' } = {},
  ) => {
    return (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const target = e.currentTarget as SVGElement;
      target.setPointerCapture(e.pointerId);

      // Snapshot before drag starts
      beforeRef.current = stateRef.current.document?.elements.get(element.id) ?? null;
      // Also snapshot elements hosted on this one (doors/windows in a wall),
      // which the reducer re-resolves during the drag.
      hostedBeforeRef.current = new Map();
      const rawHostId = toElementId(element.id);
      const liveEls = stateRef.current.document?.elements;
      if (liveEls) {
        for (const [id, el] of liveEls) {
          if (el.hostId === rawHostId) hostedBeforeRef.current.set(id, el);
        }
      }
      endpointSideRef.current = opts.endpointSide ?? null;
      lastSnapRef.current = null;
      // Remember pointerdown position in model coords so module-defined
      // handles can compute drag deltas from a stable origin.
      const startPt = screenToSvg(e.clientX, e.clientY);
      dragStartRef.current = startPt ?? { x: 0, y: 0 };

      const moveHandler = (me: PointerEvent) => {
        const snap = snapSvgPoint(me.clientX, me.clientY);
        if (snap) {
          lastSnapRef.current = snap;
          onMove(snap.point.x, snap.point.y, snap);
        }
      };

      const upHandler = () => {
        target.removeEventListener('pointermove', moveHandler);
        target.removeEventListener('pointerup', upHandler);

        // T-junction commit path: only triggers when this drag was a MEP-
        // curve endpoint, the cursor never landed on a connector port, and
        // the cursor's final position is over a same-system pipe's body.
        const snapshot = beforeRef.current;
        const side = endpointSideRef.current;
        const finalSnap = lastSnapRef.current;
        const live = stateRef.current.document?.elements.get(element.id) ?? null;
        if (
          snapshot && live && side &&
          isMepLineTable(element.tableName) &&
          !finalSnap?.connectorHit &&
          finalSnap &&
          (live.geometry === 'line' || live.geometry === 'spatial_line')
        ) {
          const elements = stateRef.current.document?.elements;
          const cursor = side === 'start' ? live.start : live.end;
          const hit = findPipeBodyHit(cursor, elements, {
            tolerance: 0.2,
            systemType: live.attrs.system_type ?? '',
            excludeIds: new Set([element.id]),
          });
          if (hit && elements) {
            const patches = buildEndpointTJunctionPatch(
              live as MepCurveElement,
              snapshot as MepCurveElement,
              hit,
              side,
              elements,
            );
            if (patches) {
              dispatch({
                type: 'APPLY_PATCH',
                description: 'Insert T-junction',
                patches: patches.patches,
                before: patches.before,
              });
              beforeRef.current = null;
              endpointSideRef.current = null;
              lastSnapRef.current = null;
              onSnap?.(null);
              return;
            }
          }
        }

        // Default commit path: single-element resize.
        if (snapshot) {
          const liveNow = stateRef.current.document?.elements;
          const after = liveNow?.get(element.id) ?? null;
          const before = new Map<string, CanonicalElement | null>([[element.id, snapshot]]);
          const afterMap = new Map<string, CanonicalElement | null>([[element.id, after]]);
          // Include hosted children re-resolved during the drag so undo restores
          // them along with the host (matches RESIZE_ELEMENT's host re-resolve).
          for (const [id, hostedBefore] of hostedBeforeRef.current) {
            const hostedAfter = liveNow?.get(id) ?? null;
            before.set(id, hostedBefore);
            afterMap.set(id, hostedAfter);
          }
          dispatch({
            type: 'COMMIT_PREVIEW',
            description: 'Resize element',
            before,
            after: afterMap,
          });
        }
        hostedBeforeRef.current = new Map();
        beforeRef.current = null;
        endpointSideRef.current = null;
        lastSnapRef.current = null;
        onSnap?.(null);
      };

      target.addEventListener('pointermove', moveHandler);
      target.addEventListener('pointerup', upHandler);
    };
  }, [snapSvgPoint, screenToSvg, element.id, element.tableName, dispatch, onSnap]);

  // ─── Module-defined handles ─────────────────────────────────────────────────
  // When the element's module declares `selectionHandles`, that overrides the
  // built-in geometry-based defaults (line endpoints, point bbox corners,
  // polygon vertices). Returning `undefined` from the module falls through to
  // the defaults; returning `[]` hides handles entirely.
  const geometryCtx = useGeometryContext();
  const mod = getElementModule(element.tableName);
  if (mod && geometryCtx && mod.selectionHandles) {
    const facts = mod.geometry(element, geometryCtx);
    if (facts != null) {
      const customHandles = mod.selectionHandles(facts, element);
      if (customHandles !== undefined) {
        return (
          <g className="resize-handles" transform="scale(1,-1)">
            {customHandles.map(h => (
              <circle
                key={h.id}
                cx={h.position.x} cy={h.position.y}
                r={r * (h.id === 'move' || h.id === 'center' ? 1.3 : 1)}
                fill={h.color ?? '#06b6d4'} stroke="white" strokeWidth={sw}
                cursor={h.cursor ?? 'move'}
                onPointerDown={handleDrag((x, y) => {
                  const snapshot = beforeRef.current;
                  if (!snapshot) return;
                  const changes = h.onDrag({ x, y }, dragStartRef.current, snapshot);
                  if (Object.keys(changes).length === 0) return;
                  dispatch({
                    type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes,
                  });
                })}
              />
            ))}
          </g>
        );
      }
    }
  }

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
          onPointerDown={handleDrag((x, y, snap) => {
            const changes: Partial<CanonicalElement> = { start: { x, y } };
            if (isMepLineTable(element.tableName)) {
              if (snap.connectorHit) {
                (changes as { attrs: Record<string, string> }).attrs = { from: snap.connectorHit.portRef };
              } else if ('attrs' in element && element.attrs.from) {
                // Drag away from a connected port → clear the from-ref so the
                // pipe doesn't stay glued to a port it no longer touches.
                (changes as { attrs: Record<string, string> }).attrs = { from: '' };
              }
            }
            dispatch({ type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes });
          }, { endpointSide: 'start' })}
        />
        <circle
          cx={element.end.x} cy={element.end.y}
          r={r} fill="#06b6d4" stroke="white" strokeWidth={sw}
          cursor="move"
          onPointerDown={handleDrag((x, y, snap) => {
            const changes: Partial<CanonicalElement> = { end: { x, y } };
            if (isMepLineTable(element.tableName)) {
              if (snap.connectorHit) {
                (changes as { attrs: Record<string, string> }).attrs = { to: snap.connectorHit.portRef };
              } else if ('attrs' in element && element.attrs.to) {
                (changes as { attrs: Record<string, string> }).attrs = { to: '' };
              }
            }
            dispatch({ type: 'RESIZE_ELEMENT', id: element.id, preview: true, changes });
          }, { endpointSide: 'end' })}
        />
        {/* Arc midpoint handle, gated by the element type's `supportsArc`
            capability. MEP curves don't expose it — running a pipe through an
            arc isn't representable in the BimDown topology (every segment is a
            straight A→B between two nodes), and the "slide the run sideways"
            gesture is covered by dragging the pipe body itself with run-aware
            selection in selectTool. Grids and braces opt out as straight-only
            linear types. */}
        {supportsArcEdit(element.tableName) && (
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
        )}
        <LengthLabel from={element.start} to={element.end} scale={scale} length={displayLen} projectUnit={projectUnit} />
      </g>
    );
  }

  if (element.geometry === 'point') {
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

/** Build the patches that turn an "endpoint dragged onto another pipe's body"
 *  drop into a T-junction:
 *  - Resets the dragged pipe's endpoint to the projection point + wires its
 *    `from` / `to` to the new tee node id.
 *  - Splits the target pipe in two (upstream half keeps the original id;
 *    downstream half is a brand-new row), both wired to the new node.
 *  - Creates the new passive mep_node at the projection point.
 *
 *  `before` is built from the pre-preview snapshot for the dragged pipe and
 *  from the current document for everything else (those weren't previewed). */
interface EndpointTJunctionPatch {
  patches: Map<string, CanonicalElement | null>;
  before: Map<string, CanonicalElement | null>;
}

function buildEndpointTJunctionPatch(
  liveDragged: MepCurveElement,
  preDragSnapshot: MepCurveElement,
  hit: ReturnType<typeof findPipeBodyHit> & object,
  side: 'start' | 'end',
  elements: ReadonlyMap<string, CanonicalElement>,
): EndpointTJunctionPatch | null {
  const target = hit.pipe;
  if (target.id === liveDragged.id) return null;

  const existingIds = new Set(elements.keys());
  const newNodeId = generateId('mep_node', existingIds);
  existingIds.add(newNodeId);
  const newPipeId = generateId(target.tableName, existingIds);
  existingIds.add(newPipeId);

  const isSpatial = target.geometry === 'spatial_line';
  const spatialT = target as unknown as { startZ?: number; endZ?: number };
  const splitPoint = hit.point;

  // Update target pipe: keeps id, end → splitPoint, attrs.to → newNodeId.
  const updatedTarget: MepCurveElement = {
    ...target,
    end: { x: splitPoint.x, y: splitPoint.y },
    ...(isSpatial ? { endZ: spatialT.startZ ?? 0 } : {}),
    attrs: { ...target.attrs, to: newNodeId },
  } as MepCurveElement;

  // New downstream half of target.
  const newDownstream: MepCurveElement = {
    ...target,
    id: newPipeId,
    start: { x: splitPoint.x, y: splitPoint.y },
    ...(isSpatial ? { startZ: spatialT.endZ ?? 0 } : {}),
    attrs: {
      ...target.attrs,
      id: newPipeId,
      from: newNodeId,
      to: target.attrs.to ?? '',
    },
  } as MepCurveElement;

  // Update dragged pipe: snap the live endpoint to the projection point and
  // wire the matching ref.
  const draggedPatch: MepCurveElement = {
    ...liveDragged,
    ...(side === 'start'
      ? { start: { x: splitPoint.x, y: splitPoint.y } }
      : { end:   { x: splitPoint.x, y: splitPoint.y } }),
    attrs: {
      ...liveDragged.attrs,
      ...(side === 'start' ? { from: newNodeId } : { to: newNodeId }),
    },
  } as MepCurveElement;

  // New passive mep_node at the split point.
  const baseNodeAttrs = defaultAttrs('mep_node', '');
  const newNode: PointElement = {
    id: newNodeId,
    tableName: 'mep_node',
    discipline: target.discipline,
    geometry: 'point',
    position: { x: splitPoint.x, y: splitPoint.y },
    width: 0,
    height: 0,
    attrs: {
      ...baseNodeAttrs,
      id: newNodeId,
      system_type: target.attrs.system_type ?? '',
      kind: '',
    },
  };

  const patches = new Map<string, CanonicalElement | null>();
  patches.set(liveDragged.id, draggedPatch);
  patches.set(target.id, updatedTarget);
  patches.set(newPipeId, newDownstream);
  patches.set(newNodeId, newNode);

  // History should record the dragged pipe's PRE-PREVIEW snapshot as
  // before, not the live preview state. The other three patches default to
  // the live document's value (null for the new ones, the original target
  // row for the split source).
  const before = new Map<string, CanonicalElement | null>();
  before.set(liveDragged.id, preDragSnapshot);

  return { patches, before };
}
