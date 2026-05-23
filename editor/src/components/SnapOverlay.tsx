import { useTranslation } from 'react-i18next';
import type { SnapResult, SnapType, GridDistanceInfo } from '../utils/snap.ts';
import type { Point } from '../model/elements.ts';

interface SnapOverlayProps {
  snap: SnapResult | null;
  scale: number;
}

const GUIDE_EXTENT = 500;

// Distinct colors per snap type so the user can tell snaps apart at a glance.
const ENDPOINT_COLOR = '#06b6d4'; // cyan
const CENTER_COLOR = '#f59e0b';   // orange
const MIDPOINT_COLOR = '#a855f7'; // purple
const GRIDLINE_COLOR = '#fbbf24'; // amber/yellow
const EDGE_COLOR = '#4ecdc4';     // teal (legacy)
const ANGLE_COLOR = '#a8e6cf';    // mint (legacy)
const GRID_COLOR = '#ffd166';     // pale yellow (perpendicular grid-distance)
const OBJECT_COLOR = '#ff6b6b';   // fallback

function colorForSnapType(t?: SnapType): string {
  if (!t) return OBJECT_COLOR;
  if (t === 'endpoint') return ENDPOINT_COLOR;
  if (t === 'center') return CENTER_COLOR;
  if (t === 'midpoint') return MIDPOINT_COLOR;
  if (t === 'gridline') return GRIDLINE_COLOR;
  if (t === 'edge') return EDGE_COLOR;
  if (t === 'angle') return ANGLE_COLOR;
  if (t === 'grid') return GRID_COLOR;
  return OBJECT_COLOR;
}

function snapTypeI18nKey(t?: SnapType): string | null {
  if (t === 'endpoint') return 'snap.endpoint';
  if (t === 'center') return 'snap.center';
  if (t === 'midpoint') return 'snap.midpoint';
  if (t === 'gridline') return 'snap.gridline';
  return null;
}

/**
 * Distance from snap point to the closest endpoint among point guides.
 * Used to emphasize the marker when the cursor result lands exactly on an
 * endpoint target.
 */
function isOnEndpoint(point: Point, guides: readonly { type: string; x: number; y: number; snapType?: SnapType }[]): boolean {
  for (const g of guides) {
    if (g.type === 'point' && g.snapType === 'endpoint') {
      const dx = g.x - point.x;
      const dy = g.y - point.y;
      if (dx * dx + dy * dy < 1e-12) return true;
    }
  }
  return false;
}

/** Render the snap-point marker based on snap type */
function SnapMarker({ x, y, snapType, s, sw, scale, emphasizeEndpoint, labelText }: {
  x: number; y: number; snapType?: SnapType; s: number; sw: number;
  scale: number;
  emphasizeEndpoint?: boolean;
  /** Localized word for this snap type — empty string disables the label. */
  labelText: string;
}) {
  const color = colorForSnapType(snapType);
  // All marker dimensions are kept constant in *screen* pixels by dividing
  // by `scale` (SVG units per screen pixel). Otherwise model-unit sizes
  // would balloon visually as the user zooms in.
  const r = 0.4 / scale;
  const labelSize = 0.7 / scale;
  const labelDx = r + 0.05 / scale;
  const labelDy = -(r + 0.05 / scale);

  // Common label rendering (flipped because parent group has scale(1,-1)).
  const label = labelText ? (
    <text
      x={x + labelDx}
      y={-(y - labelDy)}
      fill={color}
      fontSize={labelSize}
      fontFamily="monospace"
      fontWeight="bold"
      transform="scale(1,-1)"
      opacity={0.95}
    >
      {labelText}
    </text>
  ) : null;

  switch (snapType) {
    case 'endpoint': {
      // Filled circle + cyan ring. When the resulting position lands exactly
      // on the endpoint, show a larger ring + X so the user can't miss it.
      const bigR = 0.6 / scale;
      return (
        <g opacity={0.95}>
          {emphasizeEndpoint && (
            <>
              <circle cx={x} cy={y} r={bigR} fill="none" stroke={color} strokeWidth={sw * 2.2} />
              <line
                x1={x - bigR * 0.7} y1={y - bigR * 0.7}
                x2={x + bigR * 0.7} y2={y + bigR * 0.7}
                stroke={color} strokeWidth={sw * 2}
              />
              <line
                x1={x - bigR * 0.7} y1={y + bigR * 0.7}
                x2={x + bigR * 0.7} y2={y - bigR * 0.7}
                stroke={color} strokeWidth={sw * 2}
              />
            </>
          )}
          <circle cx={x} cy={y} r={r} fill={color} stroke={color} strokeWidth={sw} />
          {label}
        </g>
      );
    }
    case 'center':
      return (
        <g opacity={0.95}>
          <circle cx={x} cy={y} r={r} fill={color} stroke={color} strokeWidth={sw} />
          {label}
        </g>
      );
    case 'midpoint':
      return (
        <g opacity={0.95}>
          <circle cx={x} cy={y} r={r} fill={color} stroke={color} strokeWidth={sw} />
          {label}
        </g>
      );
    case 'gridline': {
      // Crosshair through the snap point + small label.
      const t = 0.9 / scale;
      return (
        <g opacity={0.95}>
          <line x1={x - t} y1={y} x2={x + t} y2={y} stroke={color} strokeWidth={sw * 1.6} />
          <line x1={x} y1={y - t} x2={x} y2={y + t} stroke={color} strokeWidth={sw * 1.6} />
          <circle cx={x} cy={y} r={r * 0.6} fill={color} />
          {label}
        </g>
      );
    }
    case 'edge': {
      // Crosshair tick mark (legacy)
      const t = s * 1.0;
      return (
        <g opacity={0.9}>
          <line x1={x - t} y1={y} x2={x + t} y2={y} stroke={color} strokeWidth={sw * 1.5} />
          <line x1={x} y1={y - t} x2={x} y2={y + t} stroke={color} strokeWidth={sw * 1.5} />
        </g>
      );
    }
    case 'angle':
      // Small circle at angle snap point
      return <circle cx={x} cy={y} r={s * 0.5} fill={ANGLE_COLOR} opacity={0.9} />;
    default:
      // Generic circle (fallback)
      return (
        <g>
          <circle cx={x} cy={y} r={s} fill="none" stroke={color} strokeWidth={sw * 1.5} />
          <circle cx={x} cy={y} r={s * 0.35} fill={color} />
        </g>
      );
  }
}

const DIM_COLOR = '#8cb4ff';

function formatDim(meters: number): string {
  if (meters < 0.01) return `${(meters * 1000).toFixed(1)}`;
  if (meters < 1) return `${(meters * 1000).toFixed(0)}`;
  return `${meters.toFixed(3)}`;
}

/** Render a dimension line from snap point to the nearest grid line */
function GridDimension({ from, info, scale }: {
  from: { x: number; y: number };
  info: GridDistanceInfo;
  scale: number;
}) {
  const sw = 0.04 / scale;
  const fontSize = 0.7 / scale;
  const tickLen = 0.2 / scale;
  const { gridPoint, distance } = info;

  if (distance < 1e-6) return null;

  // Midpoint of dimension line for label
  const mx = (from.x + gridPoint.x) / 2;
  const my = (from.y + gridPoint.y) / 2;

  // Direction from gridPoint to from (for tick orientation)
  const dx = from.x - gridPoint.x;
  const dy = from.y - gridPoint.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return null;
  // Perpendicular for ticks
  const px = -dy / len * tickLen;
  const py = dx / len * tickLen;

  return (
    <g opacity={0.8}>
      {/* Dimension line */}
      <line
        x1={from.x} y1={from.y}
        x2={gridPoint.x} y2={gridPoint.y}
        stroke={DIM_COLOR} strokeWidth={sw}
      />
      {/* Tick at snap point */}
      <line
        x1={from.x - px} y1={from.y - py}
        x2={from.x + px} y2={from.y + py}
        stroke={DIM_COLOR} strokeWidth={sw}
      />
      {/* Tick at grid point */}
      <line
        x1={gridPoint.x - px} y1={gridPoint.y - py}
        x2={gridPoint.x + px} y2={gridPoint.y + py}
        stroke={DIM_COLOR} strokeWidth={sw}
      />
      {/* Label */}
      <text
        x={mx + py * 2}
        y={-(my + (-px) * 2)}
        fill={DIM_COLOR}
        fontSize={fontSize}
        fontFamily="monospace"
        textAnchor="middle"
        dominantBaseline="middle"
        transform="scale(1,-1)"
      >
        {formatDim(distance)}
      </text>
    </g>
  );
}

export default function SnapOverlay({ snap, scale }: SnapOverlayProps) {
  const { t } = useTranslation();
  if (!snap) return null;
  const { guides } = snap;
  const hasGuides = guides.length > 0;
  const hasDims = snap.nearestGridX || snap.nearestGridY;
  if (!hasGuides && !hasDims) return null;

  const sw = 0.06 / scale;
  const dashLen = 0.6 / scale;
  const gapLen = 0.4 / scale;
  // Slightly bolder stroke for axis-alignment guides so they're easier to see.
  const axisSw = sw * 1.5;
  const axisDash = `${dashLen * 1.2},${gapLen * 0.8}`;
  const markerSize = 0.3 / scale;

  const endpointHit = isOnEndpoint(snap.point, guides) && snap.dominantType === 'endpoint';

  return (
    <g className="snap-overlay" transform="scale(1,-1)">
      {guides.map((g, i) => {
        if (g.type === 'vline') {
          return (
            <line
              key={i}
              x1={g.x} y1={g.y - GUIDE_EXTENT}
              x2={g.x} y2={g.y + GUIDE_EXTENT}
              stroke={colorForSnapType(g.snapType)}
              strokeWidth={axisSw}
              strokeDasharray={axisDash}
              opacity={0.85}
            />
          );
        }
        if (g.type === 'hline') {
          return (
            <line
              key={i}
              x1={g.x - GUIDE_EXTENT} y1={g.y}
              x2={g.x + GUIDE_EXTENT} y2={g.y}
              stroke={colorForSnapType(g.snapType)}
              strokeWidth={axisSw}
              strokeDasharray={axisDash}
              opacity={0.85}
            />
          );
        }
        if (g.type === 'point') {
          const isEndpointMarker = g.snapType === 'endpoint';
          const emphasize = isEndpointMarker
            && endpointHit
            && Math.abs(g.x - snap.point.x) < 1e-9
            && Math.abs(g.y - snap.point.y) < 1e-9;
          return (
            <SnapMarker
              key={i}
              x={g.x} y={g.y}
              snapType={g.snapType}
              s={markerSize}
              sw={sw}
              scale={scale}
              emphasizeEndpoint={emphasize}
              labelText={(() => { const k = snapTypeI18nKey(g.snapType); return k ? t(k) : ''; })()}
            />
          );
        }
        if (g.type === 'edge_segment' && g.x2 != null && g.y2 != null) {
          return (
            <line
              key={i}
              x1={g.x} y1={g.y}
              x2={g.x2} y2={g.y2}
              stroke={colorForSnapType(g.snapType)}
              strokeWidth={sw * 2}
              opacity={0.55}
            />
          );
        }
        if (g.type === 'angle_line' && g.x2 != null && g.y2 != null) {
          // Label position: 15% along the ray from anchor
          const lx = g.x + (g.x2 - g.x) * 0.15;
          const ly = g.y + (g.y2! - g.y) * 0.15;
          const labelSize = 1.0 / scale;
          return (
            <g key={i}>
              <line
                x1={g.x} y1={g.y}
                x2={g.x2} y2={g.y2}
                stroke={ANGLE_COLOR}
                strokeWidth={sw}
                strokeDasharray={`${dashLen},${gapLen}`}
                opacity={0.6}
              />
              {g.label && (
                <text
                  x={lx + 0.3 / scale}
                  y={-ly}
                  fill={ANGLE_COLOR}
                  fontSize={labelSize}
                  fontFamily="monospace"
                  transform="scale(1,-1)"
                  opacity={0.8}
                >
                  {g.label}
                </text>
              )}
            </g>
          );
        }
        if (g.type === 'length_ring' && g.x2 != null) {
          const radius = g.x2; // x2 carries the radius
          const labelSize = 1.0 / scale;
          return (
            <g key={i}>
              <circle
                cx={g.x} cy={g.y}
                r={radius}
                fill="none"
                stroke="#ffa07a"
                strokeWidth={sw}
                strokeDasharray={`${dashLen * 0.4},${gapLen * 0.6}`}
                opacity={0.4}
              />
              {g.label && (
                <text
                  x={g.x + radius + 0.3 / scale}
                  y={-g.y}
                  fill="#ffa07a"
                  fontSize={labelSize}
                  fontFamily="monospace"
                  transform="scale(1,-1)"
                  opacity={0.8}
                >
                  {g.label}
                </text>
              )}
            </g>
          );
        }
        return null;
      })}
      {/* Grid distance dimensions */}
      {snap.nearestGridX && (
        <GridDimension from={snap.point} info={snap.nearestGridX} scale={scale} />
      )}
      {snap.nearestGridY && (
        <GridDimension from={snap.point} info={snap.nearestGridY} scale={scale} />
      )}
    </g>
  );
}
