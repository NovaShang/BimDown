import type { SnapResult } from '../utils/snap.ts';

interface SnapOverlayProps {
  snap: SnapResult | null;
  scale: number;
}

const GUIDE_EXTENT = 500; // SVG units — long enough to cross the viewport

export default function SnapOverlay({ snap, scale }: SnapOverlayProps) {
  if (!snap) return null;
  const { guides } = snap;
  if (guides.length === 0) return null;

  const sw = 0.06 / scale;
  const dashLen = 0.6 / scale;
  const gapLen = 0.4 / scale;
  const dotR = 0.3 / scale;

  return (
    <g className="snap-overlay" transform="scale(1,-1)">
      {guides.map((g, i) => {
        if (g.type === 'vline') {
          const isGrid = g.label === 'grid';
          return (
            <line
              key={i}
              x1={g.x} y1={g.y - GUIDE_EXTENT}
              x2={g.x} y2={g.y + GUIDE_EXTENT}
              stroke={isGrid ? '#ffd166' : '#ff6b6b'}
              strokeWidth={sw}
              strokeDasharray={isGrid ? `${dashLen * 0.5},${gapLen}` : `${dashLen},${gapLen}`}
              opacity={isGrid ? 0.5 : 0.7}
            />
          );
        }
        if (g.type === 'hline') {
          const isGrid = g.label === 'grid';
          return (
            <line
              key={i}
              x1={g.x - GUIDE_EXTENT} y1={g.y}
              x2={g.x + GUIDE_EXTENT} y2={g.y}
              stroke={isGrid ? '#ffd166' : '#ff6b6b'}
              strokeWidth={sw}
              strokeDasharray={isGrid ? `${dashLen * 0.5},${gapLen}` : `${dashLen},${gapLen}`}
              opacity={isGrid ? 0.5 : 0.7}
            />
          );
        }
        if (g.type === 'point') {
          return (
            <g key={i}>
              <circle
                cx={g.x} cy={g.y}
                r={dotR}
                fill="none" stroke="#ff6b6b" strokeWidth={sw * 1.5}
              />
              <circle
                cx={g.x} cy={g.y}
                r={dotR * 0.35}
                fill="#ff6b6b"
              />
            </g>
          );
        }
        return null;
      })}
    </g>
  );
}
