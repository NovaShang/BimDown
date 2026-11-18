import type { DrawingState, Tool } from '../state/editorTypes.ts';
import type { CanonicalElement, Point } from '../model/elements.ts';
import type { ProjectUnit } from '../types.ts';
import { resolveLineStrokeWidth } from '../utils/geometry.ts';
import { clicksRequired, isMultiClickStair } from '../tools/drawStairTool.ts';
import { layoutPlan } from '../geometry/stair.ts';
import { sketchToLayout } from '../geometry/stairSketch.ts';
import { gatherConnectorSnapPoints, isMepLineTable } from '../utils/connectorSnap.ts';
import { formatLength } from '../utils/units.ts';
import { isWallDrawTable } from '../tools/wallDrawTool.ts';
import WallDrawPreview, { TypedBadge } from './WallDrawPreview.tsx';
import { typedOffsetPoint } from '../tools/drawPointTool.ts';
import { pointSizeAttrsForTable } from '../model/tableRegistry.ts';
import { getElementModule } from '../elements/registry.ts';
import { mepDrawingPreview } from '../mep/MepDrawingPreview.tsx';

/** Length label positioned at the midpoint of a line, offset perpendicular to it */
function LengthLabel({ from, to, scale, projectUnit }: { from: Point; to: Point; scale: number; projectUnit: ProjectUnit }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return null;

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  // Offset perpendicular to line
  const nx = -dy / len;
  const ny = dx / len;
  const offset = 0.8 / scale;
  const lx = mx + nx * offset;
  const ly = my + ny * offset;
  const fontSize = 1.0 / scale;

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
      {formatLength(len, projectUnit)}
    </text>
  );
}

/** Stair by sketch in progress (tools/stairSketchTool.ts). */
function StairSketchPreview({ drawingState, drawingAttrs, scale }: { drawingState: DrawingState; drawingAttrs: Record<string, string>; scale: number }) {
  const sk = drawingState.stairSketch ?? { boundary: [], risers: [] };
  const pts = drawingState.points;
  const cursor = drawingState.cursor;
  const riserMode = drawingAttrs.__sketch_mode === 'riser';
  const boundaryOpen = !riserMode ? [...pts, ...(cursor ? [cursor] : [])] : [];
  const boundary = sk.boundary.length >= 3 ? sk.boundary : [];
  const layout = sketchToLayout({ boundary: boundary.length ? boundary : pts.length >= 3 && !riserMode ? pts : [], risers: sk.risers }, 0, 3);
  const plan = 'error' in layout ? null : layoutPlan(layout, 1.2);
  const sw = 0.08 / scale;
  const poly = (p: { x: number; y: number }[]) => p.map(v => `${v.x},${v.y}`).join(' ');
  return (
    <g className="drawing-overlay" transform="scale(1,-1)" data-testid="stair-sketch-preview">
      {plan?.runs.map((r, i) => <polygon key={`r${i}`} points={poly(r.outline)} fill="rgba(79,195,247,0.15)" stroke="none" />)}
      {plan?.landings.map((l, i) => <polygon key={`l${i}`} points={poly(l.vertices)} fill="rgba(123,104,238,0.15)" stroke="none" />)}
      {boundary.length > 0 && <polygon points={poly(boundary)} fill="none" stroke="#22c55e" strokeWidth={sw * 1.4} />}
      {boundaryOpen.length > 1 && <polyline points={poly(boundaryOpen)} fill="none" stroke="#22c55e" strokeWidth={sw * 1.4} strokeDasharray={`${sw * 4},${sw * 2}`} />}
      {sk.risers.map(([a, b], i) => <line key={`s${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#111827" strokeWidth={sw} />)}
      {riserMode && pts.length === 1 && cursor && <line x1={pts[0].x} y1={pts[0].y} x2={cursor.x} y2={cursor.y} stroke="#111827" strokeWidth={sw} strokeDasharray={`${sw * 4},${sw * 2}`} />}
      {[...pts].map((p, i) => <circle key={`p${i}`} cx={p.x} cy={p.y} r={sw * 2.5} fill={riserMode ? '#111827' : '#22c55e'} />)}
    </g>
  );
}

interface DrawingOverlayProps {
  drawingState: DrawingState;
  activeTool: Tool;
  scale: number;
  drawingAttrs: Record<string, string>;
  tableName: string | null;
  /** Document elements — used to surface connector dots as snap targets. */
  elements?: ReadonlyMap<string, CanonicalElement> | null;
  /** Project unit so length previews honor ft / in / mm. */
  projectUnit: ProjectUnit;
  /** draw_region: members the box would create (columns / beams). */
  regionPreview?: { points: Point[]; lines: [Point, Point][] } | null;
}

/** Subtle preview ring for an available connector port. Rendered when the
 *  MEP line tool is active so the user can see snap targets ahead of time. */
function ConnectorHints({
  elements, scale,
}: { elements: ReadonlyMap<string, CanonicalElement> | null | undefined; scale: number }) {
  const ports = gatherConnectorSnapPoints(elements);
  if (ports.length === 0) return null;
  const r = 0.07;
  const tickLen = 0.13;
  const sw = 0.025 / Math.max(scale, 0.01);
  return (
    <g opacity={0.5}>
      {ports.map((p, i) => (
        <g key={i}>
          <circle
            cx={p.pos.x} cy={p.pos.y} r={r}
            fill="none" stroke="#4fc3f7" strokeWidth={sw}
          />
          <line
            x1={p.pos.x} y1={p.pos.y}
            x2={p.pos.x + p.dir.x * tickLen}
            y2={p.pos.y + p.dir.y * tickLen}
            stroke="#4fc3f7" strokeWidth={sw}
          />
        </g>
      ))}
    </g>
  );
}

export default function DrawingOverlay({ drawingState, activeTool, scale, drawingAttrs, tableName, elements, projectUnit, regionPreview }: DrawingOverlayProps) {
  const { points, cursor } = drawingState;
  const showConnectorHints = activeTool === 'draw_line' && isMepLineTable(tableName);

  // When drawing an MEP line, render connector hint dots as a background
  // layer underneath whatever per-mode preview the rest of this function
  // builds. The hints layer stays on screen even when no start point has
  // been clicked yet, so the user can see ports before placing the first
  // point.
  const connectorHintsLayer = showConnectorHints ? (
    <g className="drawing-overlay drawing-overlay-connector-hints" transform="scale(1,-1)">
      <ConnectorHints elements={elements} scale={scale} />
    </g>
  ) : null;

  const wrap = (body: React.ReactNode): React.ReactNode => {
    if (!connectorHintsLayer) return body;
    return <>{connectorHintsLayer}{body}</>;
  };

  if (activeTool === 'draw_line' && isWallDrawTable(tableName)) {
    const thickness = (tableName ? resolveLineStrokeWidth(tableName, drawingAttrs) : null) ?? (tableName === 'curtain_wall' ? 0.05 : 0.1);
    return <WallDrawPreview drawingState={drawingState} drawingAttrs={drawingAttrs} thickness={thickness} scale={scale} projectUnit={projectUnit} />;
  }

  if (activeTool === 'draw_line') {
    // Stair by sketch: boundary (green), risers (black), the stair they make (blue)
    if (tableName === 'stair' && (drawingState.stairSketch !== undefined || drawingAttrs.__sketch_mode)) {
      return wrap(<StairSketchPreview drawingState={drawingState} drawingAttrs={drawingAttrs} scale={scale} />);
    }
    // Multi-click stair (L / U) — show dots at each clicked point, plus
    // a dashed segment from the last point to the cursor.
    if (tableName === 'stair' && isMultiClickStair(drawingAttrs.stair_type)) {
      const need = clicksRequired(drawingAttrs.stair_type);
      const r1 = 0.45 / scale;
      const r2 = 0.3 / scale;
      const width = parseFloat(drawingAttrs.width || '1.2') || 1.2;

      // Preview thick band for the current segment (the run-in-progress).
      let bandLine: { from: Point; to: Point } | null = null;
      if (points.length > 0 && cursor) {
        bandLine = { from: points[points.length - 1], to: cursor };
      }

      // Tentative runs + landings the tool computed from the clicks and the cursor
      const layout = drawingState.stairPreview ? layoutPlan(drawingState.stairPreview, width) : null;
      if (layout) bandLine = null;
      const runRects = (layout?.runs ?? []).map(r => r.outline.map(v => `${v.x},${v.y}`).join(' '));
      const treadLines = (layout?.runs ?? []).flatMap(r => r.treads).concat((layout?.landings ?? []).flatMap(l => l.risers));
      const landingRects = (layout?.landings ?? []).map(l => l.vertices.map(v => `${v.x},${v.y}`).join(' '));

      return wrap(
        <g className="drawing-overlay" transform="scale(1,-1)">
          {landingRects.map((pts, i) => (
            <polygon key={`landing-${i}`}
              points={pts}
              fill="rgba(123,104,238,0.15)"
              stroke="#7b68ee" strokeWidth={0.06 / scale}
              strokeDasharray={`${0.3 / scale},${0.15 / scale}`}
            />
          ))}
          {runRects.map((pts, i) => (
            <polygon key={`run-${i}`} points={pts} fill="rgba(79,195,247,0.18)" stroke="#4fc3f7" strokeWidth={0.05 / scale} />
          ))}
          {treadLines.map(([a, b], i) => (
            <line key={`tread-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#4fc3f7" strokeWidth={0.03 / scale} opacity={0.8} />
          ))}
          {bandLine && (
            <line
              x1={bandLine.from.x} y1={bandLine.from.y}
              x2={bandLine.to.x} y2={bandLine.to.y}
              stroke="#4fc3f7" strokeWidth={width} strokeLinecap="butt" opacity="0.25"
            />
          )}
          {/* Lines between placed points */}
          {points.map((p, i) => {
            const next = i < points.length - 1 ? points[i + 1] : cursor;
            if (!next) return null;
            return (
              <line key={i}
                x1={p.x} y1={p.y} x2={next.x} y2={next.y}
                stroke="#4fc3f7" strokeWidth={0.12 / scale}
                strokeDasharray={i === points.length - 1 ? `${0.6 / scale},${0.3 / scale}` : undefined}
              />
            );
          })}
          {points.map((p, i) => (
            <circle key={`pt-${i}`} cx={p.x} cy={p.y} r={r1} fill="#4fc3f7" />
          ))}
          {cursor && (
            <circle cx={cursor.x} cy={cursor.y} r={r2} fill="#4fc3f7" opacity="0.6" />
          )}
          {/* Click counter hint */}
          {cursor && (
            <text
              x={cursor.x} y={-(cursor.y - 0.6 / scale)}
              fill="#4fc3f7" fontSize={0.9 / scale} fontFamily="monospace"
              textAnchor="middle" transform="scale(1,-1)" opacity="0.85"
            >
              {`${points.length + 1}/${need}`}
            </text>
          )}
        </g>
      );
    }

    // Vertical-pipe single-click mode: render a single cursor circle marker
    // (cross-section of the vertical pipe) instead of the 2-point preview.
    if (drawingAttrs.__vertical_mode === 'true' && cursor) {
      const thickness = tableName ? (resolveLineStrokeWidth(tableName, drawingAttrs) ?? 0) : 0;
      const r = thickness > 0 ? thickness / 2 : Math.max(0.4 / scale, 0.05);
      return wrap(
        <g className="drawing-overlay" transform="scale(1,-1)">
          <circle
            cx={cursor.x} cy={cursor.y} r={r}
            fill="#4fc3f7" fillOpacity="0.25"
            stroke="#4fc3f7" strokeWidth={0.08 / scale}
          />
          <circle cx={cursor.x} cy={cursor.y} r={0.18 / scale} fill="#4fc3f7" />
          <line x1={cursor.x - r - (0.3 / scale)} y1={cursor.y} x2={cursor.x + r + (0.3 / scale)} y2={cursor.y} stroke="#4fc3f7" strokeWidth={0.06 / scale} opacity="0.5" />
          <line x1={cursor.x} y1={cursor.y - r - (0.3 / scale)} x2={cursor.x} y2={cursor.y + r + (0.3 / scale)} stroke="#4fc3f7" strokeWidth={0.06 / scale} opacity="0.5" />
        </g>
      );
    }
    if (points.length === 1 && cursor) {
      // Show real thickness for walls/ducts/pipes
      const thickness = tableName ? (resolveLineStrokeWidth(tableName, drawingAttrs) ?? 0) : 0;
      const showThick = thickness > 0;
      return wrap(
        <g className="drawing-overlay" transform="scale(1,-1)">
          {showThick ? (
            <line
              x1={points[0].x} y1={points[0].y}
              x2={cursor.x} y2={cursor.y}
              stroke="#4fc3f7" strokeWidth={thickness} strokeLinecap="butt"
              opacity="0.35"
            />
          ) : null}
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#4fc3f7" strokeWidth={0.12 / scale} strokeDasharray={`${0.6 / scale},${0.3 / scale}`}
          />
          <circle cx={points[0].x} cy={points[0].y} r={0.45 / scale} fill="#4fc3f7" />
          <circle cx={cursor.x} cy={cursor.y} r={0.3 / scale} fill="#4fc3f7" opacity="0.6" />
          <LengthLabel from={points[0]} to={cursor} scale={scale} projectUnit={projectUnit} />
        </g>
      );
    }
    // Even with no points placed and no cursor preview, surface the
    // connector hints so the user sees ports right after activating the tool.
    return wrap(null);
  }

  if (activeTool === 'draw_slope_arrow') {
    // Slope arrow: tail dot, rubber shaft to the cursor with its head
    if (points.length !== 1 || !cursor) return null;
    const t = points[0];
    const l = Math.hypot(cursor.x - t.x, cursor.y - t.y);
    if (l < 1e-6) return null;
    const ux = (cursor.x - t.x) / l, uy = (cursor.y - t.y) / l;
    const h = Math.min(0.35, l * 0.3);
    const head = `${cursor.x - ux * h - uy * h * 0.45},${cursor.y - uy * h + ux * h * 0.45} ${cursor.x},${cursor.y} ${cursor.x - ux * h + uy * h * 0.45},${cursor.y - uy * h - ux * h * 0.45}`;
    return (
      <g className="drawing-overlay" transform="scale(1,-1)" data-testid="slope-arrow-preview">
        <circle cx={t.x} cy={t.y} r={0.12 / scale} fill="#4fc3f7" />
        <line x1={t.x} y1={t.y} x2={cursor.x} y2={cursor.y} stroke="#4fc3f7" strokeWidth={0.08 / scale} />
        <polyline points={head} fill="none" stroke="#4fc3f7" strokeWidth={0.08 / scale} />
      </g>
    );
  }

  if (activeTool === 'rotate') {
    if (points.length === 1 && cursor) {
      const center = points[0];
      const dx = cursor.x - center.x;
      const dy = cursor.y - center.y;
      const rawAngle = Math.atan2(dy, dx) * 180 / Math.PI;
      const angleDeg = Math.round(rawAngle / 15) * 15;
      // Radius of the guide circle
      const r = 0.8 / scale;
      // Endpoint on guide circle for angle indicator
      const rad = angleDeg * Math.PI / 180;
      const ex = center.x + r * Math.cos(rad);
      const ey = center.y + r * Math.sin(rad);
      const fontSize = 0.9 / scale;
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <circle cx={center.x} cy={center.y} r={r} fill="none" stroke="#4fc3f7" strokeWidth={0.06 / scale} strokeDasharray={`${0.3 / scale},${0.15 / scale}`} opacity="0.5" />
          <line x1={center.x} y1={center.y} x2={ex} y2={ey} stroke="#4fc3f7" strokeWidth={0.1 / scale} />
          <circle cx={center.x} cy={center.y} r={0.15 / scale} fill="#4fc3f7" />
          <circle cx={ex} cy={ey} r={0.2 / scale} fill="#4fc3f7" opacity="0.7" />
          <text
            x={center.x} y={-(center.y + r + 0.4 / scale)}
            fill="#4fc3f7" fontSize={fontSize} fontFamily="monospace"
            textAnchor="middle" transform="scale(1,-1)" opacity="0.9"
          >
            {angleDeg}°
          </text>
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'relocate_hosted') {
    // Show hosted span preview (start → cursor)
    if (points.length === 1 && cursor) {
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#ffa726" strokeWidth={0.3 / scale} opacity="0.45"
          />
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#ffa726" strokeWidth={0.08 / scale}
          />
          <circle cx={points[0].x} cy={points[0].y} r={0.3 / scale} fill="#ffa726" opacity="0.7" />
          <circle cx={cursor.x} cy={cursor.y} r={0.3 / scale} fill="#ffa726" opacity="0.7" />
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'relocate') {
    if (points.length === 1 && cursor) {
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#ffa726" strokeWidth={0.12 / scale} strokeDasharray={`${0.6 / scale},${0.3 / scale}`}
          />
          <circle cx={points[0].x} cy={points[0].y} r={0.45 / scale} fill="#ffa726" />
          <circle cx={cursor.x} cy={cursor.y} r={0.3 / scale} fill="#ffa726" opacity="0.6" />
          <LengthLabel from={points[0]} to={cursor} scale={scale} projectUnit={projectUnit} />
          {drawingState.typed && (
            <g transform="scale(1,-1)"><TypedBadge at={cursor} typed={drawingState.typed} scale={scale} labels={['L', '∠']} /></g>
          )}
        </g>
      );
    }
    return null;
  }

  if ((activeTool === 'trim_corner' || activeTool === 'trim_single') && drawingState.pick?.line) {
    const { start, end } = drawingState.pick.line;
    return (
      <g className="drawing-overlay" transform="scale(1,-1)" pointerEvents="none">
        <line x1={start.x} y1={start.y} x2={end.x} y2={end.y}
          stroke="#ffa726" strokeWidth={0.14 / scale} strokeDasharray={`${0.5 / scale},${0.25 / scale}`} />
        <circle cx={drawingState.pick.point.x} cy={drawingState.pick.point.y} r={0.3 / scale} fill="#ffa726" />
      </g>
    );
  }

  if (activeTool === 'draw_pick') {
    // Boundary the click would create (floor / roof / ceiling from walls or a room).
    if (points.length < 3) return null;
    return (
      <g className="drawing-overlay" transform="scale(1,-1)" pointerEvents="none">
        <polygon points={points.map(p => `${p.x},${p.y}`).join(' ')}
          fill="#4fc3f7" fillOpacity="0.1"
          stroke="#4fc3f7" strokeWidth={0.1 / scale} strokeDasharray={`${0.5 / scale},${0.25 / scale}`} />
      </g>
    );
  }

  if (activeTool === 'draw_region') {
    if (points.length === 1 && cursor) {
      const a = points[0];
      const x = Math.min(a.x, cursor.x), y = Math.min(a.y, cursor.y);
      const w = Math.abs(cursor.x - a.x), h = Math.abs(cursor.y - a.y);
      const r = 0.25 / scale;
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <rect x={x} y={y} width={w} height={h}
            fill="#4fc3f7" fillOpacity="0.08"
            stroke="#4fc3f7" strokeWidth={0.08 / scale} strokeDasharray={`${0.5 / scale},${0.25 / scale}`} />
          {regionPreview?.lines.map(([s, e], i) => (
            <line key={`l${i}`} x1={s.x} y1={s.y} x2={e.x} y2={e.y}
              stroke="#e07a2f" strokeWidth={0.12 / scale} opacity="0.8" />
          ))}
          {regionPreview?.points.map((p, i) => (
            <rect key={`p${i}`} x={p.x - r} y={p.y - r} width={2 * r} height={2 * r}
              fill="#e07a2f" opacity="0.8" />
          ))}
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'draw_point') {
    const mepPreview = mepDrawingPreview({ activeTool, tableName, points, cursor, drawingAttrs, scale });
    if (mepPreview) return mepPreview;
    const Preview = tableName ? getElementModule(tableName)?.placementPreview : undefined;
    // Typed placement: absolute X / Y badge at the cursor, or ('@') ΔX / ΔY from the reference with the preview at the offset.
    const typed = drawingState.typed;
    const ref = typed?.relative ? points[0] : undefined;
    const at = ref && typed ? typedOffsetPoint(ref, typed, projectUnit ?? 'm') : cursor;
    const typedLayer = typed && cursor ? (ref ? (
      <g className="drawing-overlay" transform="scale(1,-1)">
        <line x1={ref.x} y1={ref.y} x2={at!.x} y2={at!.y} stroke="#ffa726" strokeWidth={0.06 / scale} strokeDasharray={`${0.4 / scale},${0.2 / scale}`} />
        <circle cx={ref.x} cy={ref.y} r={0.3 / scale} fill="#ffa726" />
        <g transform="scale(1,-1)"><TypedBadge at={ref} typed={typed} scale={scale} labels={['ΔX', 'ΔY']} /></g>
      </g>
    ) : (
      <g className="drawing-overlay" transform="scale(1,-1)"><g transform="scale(1,-1)"><TypedBadge at={cursor} typed={typed} scale={scale} labels={['X', 'Y']} /></g></g>
    )) : null;
    if (at && Preview) {
      return <>{typedLayer}<Preview cursor={at} rotation={drawingState.rotation} attrs={drawingAttrs} scale={scale} /></>;
    }
    if (at) {
      const cursor = at;
      // Plan size attrs: size_x/size_y, foundation width/length.
      const [sxKey, syKey] = tableName ? pointSizeAttrsForTable(tableName) : ['size_x', 'size_y'];
      const w = parseFloat(drawingAttrs[sxKey] || '0.3') || 0.3;
      const h = parseFloat(drawingAttrs[syKey] || '') || w;
      const hw = w / 2;
      const hh = h / 2;
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <rect
            x={cursor.x - hw} y={cursor.y - hh}
            width={w} height={h}
            fill="#4fc3f7" opacity="0.25"
            stroke="#4fc3f7" strokeWidth={0.09 / scale}
          />
          <line x1={cursor.x - hw - (0.3 / scale)} y1={cursor.y} x2={cursor.x + hw + (0.3 / scale)} y2={cursor.y} stroke="#4fc3f7" strokeWidth={0.06 / scale} opacity="0.5" />
          <line x1={cursor.x} y1={cursor.y - hh - (0.3 / scale)} x2={cursor.x} y2={cursor.y + hh + (0.3 / scale)} stroke="#4fc3f7" strokeWidth={0.06 / scale} opacity="0.5" />
          {typedLayer && <g transform="scale(1,-1)">{typedLayer}</g>}
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'draw_grid') {
    if (points.length === 1 && cursor) {
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#ef476f" strokeWidth={0.12 / scale} strokeDasharray={`${0.45 / scale},${0.3 / scale}`}
            opacity="0.6"
          />
          {/* The head (bubble) lands at the second click */}
          <circle cx={points[0].x} cy={points[0].y} r={0.3 / scale} fill="#ef476f" opacity="0.4" />
          <circle cx={cursor.x} cy={cursor.y} r={0.45 / scale} fill="none" stroke="#ef476f" strokeWidth={0.08 / scale} opacity="0.6" />
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'draw_hosted') {
    // points[0] = start, cursor = end of the hosted span on the wall
    if (points.length === 1 && cursor) {
      return (
        <g className="drawing-overlay" transform="scale(1,-1)">
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#4fc3f7" strokeWidth={0.3 / scale}
            opacity="0.45"
          />
          <line
            x1={points[0].x} y1={points[0].y}
            x2={cursor.x} y2={cursor.y}
            stroke="#4fc3f7" strokeWidth={0.08 / scale}
          />
          <circle cx={points[0].x} cy={points[0].y} r={0.3 / scale} fill="#4fc3f7" opacity="0.7" />
          <circle cx={cursor.x} cy={cursor.y} r={0.3 / scale} fill="#4fc3f7" opacity="0.7" />
          <LengthLabel from={points[0]} to={cursor} scale={scale} projectUnit={projectUnit} />
        </g>
      );
    }
    return null;
  }

  if (activeTool === 'draw_polygon') {
    if (points.length === 0 && !cursor) return null;

    const allPts = cursor ? [...points, cursor] : points;
    if (allPts.length < 2 && !cursor) return null;

    const polyPoints = allPts.map(p => `${p.x},${p.y}`).join(' ');

    return (
      <g className="drawing-overlay" transform="scale(1,-1)">
        {/* Fill preview */}
        {allPts.length >= 3 && (
          <polygon
            points={polyPoints}
            fill="#4fc3f7" fillOpacity="0.15"
            stroke="#4fc3f7" strokeWidth={0.15 / scale} strokeDasharray={`${0.6 / scale},${0.3 / scale}`}
          />
        )}
        {/* Lines between placed points */}
        {points.map((p, i) => {
          const next = i < points.length - 1 ? points[i + 1] : cursor;
          if (!next) return null;
          return (
            <line
              key={i}
              x1={p.x} y1={p.y} x2={next.x} y2={next.y}
              stroke="#4fc3f7" strokeWidth={0.24 / scale}
            />
          );
        })}
        {/* Closing line preview */}
        {cursor && points.length >= 2 && (
          <line
            x1={allPts[allPts.length - 1].x} y1={allPts[allPts.length - 1].y}
            x2={points[0].x} y2={points[0].y}
            stroke="#4fc3f7" strokeWidth={0.15 / scale} strokeDasharray={`${0.45 / scale},${0.3 / scale}`} opacity="0.5"
          />
        )}
        {/* Vertex dots */}
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={0.36 / scale} fill="#4fc3f7" />
        ))}
        {/* Cursor dot */}
        {cursor && (
          <circle cx={cursor.x} cy={cursor.y} r={0.24 / scale} fill="#4fc3f7" opacity="0.6" />
        )}
        {/* Typed vertex: X / Y (first), length / angle or ΔX / ΔY from the last vertex */}
        {drawingState.typed && (cursor || points.length > 0) && (
          <g transform="scale(1,-1)"><TypedBadge at={points.length ? points[points.length - 1] : cursor!} typed={drawingState.typed} scale={scale}
            labels={points.length === 0 ? ['X', 'Y'] : drawingState.typed.relative ? ['ΔX', 'ΔY'] : ['L', '∠']} /></g>
        )}
      </g>
    );
  }

  return null;
}
