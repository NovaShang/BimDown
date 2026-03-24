import type { SnapResult, SnapType, GridDistanceInfo } from '../utils/snap.ts';

interface SnapOverlayProps {
  snap: SnapResult | null;
  scale: number;
}

const GUIDE_EXTENT = 500;

// Colors by snap category
const OBJECT_COLOR = '#ff6b6b';
const EDGE_COLOR = '#4ecdc4';
const ANGLE_COLOR = '#a8e6cf';
const GRID_COLOR = '#ffd166';
const GRIDLINE_COLOR = '#ef476f';

function colorForSnapType(t?: SnapType): string {
  if (!t) return OBJECT_COLOR;
  if (t === 'edge') return EDGE_COLOR;
  if (t === 'angle') return ANGLE_COLOR;
  if (t === 'gridline') return GRIDLINE_COLOR;
  if (t === 'grid') return GRID_COLOR;
  return OBJECT_COLOR;
}

/** Render the snap-point marker based on snap type */
function SnapMarker({ x, y, snapType, s, sw }: {
  x: number; y: number; snapType?: SnapType; s: number; sw: number;
}) {
  const color = colorForSnapType(snapType);

  switch (snapType) {
    case 'endpoint':
      // Filled square
      return (
        <rect
          x={x - s * 0.7} y={y - s * 0.7}
          width={s * 1.4} height={s * 1.4}
          fill={color} opacity={0.9}
        />
      );
    case 'center':
      // Diamond (45-degree rotated square)
      return (
        <rect
          x={x - s * 0.7} y={y - s * 0.7}
          width={s * 1.4} height={s * 1.4}
          fill="none" stroke={color} strokeWidth={sw * 1.5}
          transform={`rotate(45, ${x}, ${y})`}
          opacity={0.9}
        />
      );
    case 'midpoint': {
      // Triangle pointing up
      const h = s * 1.2;
      const hw = s * 0.8;
      const points = `${x},${y - h} ${x - hw},${y + h * 0.5} ${x + hw},${y + h * 0.5}`;
      return <polygon points={points} fill={color} opacity={0.9} />;
    }
    case 'edge': {
      // Crosshair tick mark
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
  if (!snap) return null;
  const { guides } = snap;
  const hasGuides = guides.length > 0;
  const hasDims = snap.nearestGridX || snap.nearestGridY;
  if (!hasGuides && !hasDims) return null;

  const sw = 0.06 / scale;
  const dashLen = 0.6 / scale;
  const gapLen = 0.4 / scale;
  const markerSize = 0.3 / scale;

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
              strokeWidth={sw}
              strokeDasharray={`${dashLen},${gapLen}`}
              opacity={0.7}
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
              strokeWidth={sw}
              strokeDasharray={`${dashLen},${gapLen}`}
              opacity={0.7}
            />
          );
        }
        if (g.type === 'point') {
          return (
            <SnapMarker
              key={i}
              x={g.x} y={g.y}
              snapType={g.snapType}
              s={markerSize}
              sw={sw}
            />
          );
        }
        if (g.type === 'edge_segment' && g.x2 != null && g.y2 != null) {
          return (
            <line
              key={i}
              x1={g.x} y1={g.y}
              x2={g.x2} y2={g.y2}
              stroke={EDGE_COLOR}
              strokeWidth={sw * 2}
              opacity={0.5}
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
