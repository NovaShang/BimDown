import type { CanonicalElement, LineElement } from '../model/elements.ts';

const EXT = 200; // extend grid lines far beyond endpoints

export function renderGrid(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line') return null;
  const { start, end, id, attrs } = el as LineElement;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const ux = dx / len, uy = dy / len;
  const ex1 = start.x - ux * EXT, ey1 = start.y - uy * EXT;
  const ex2 = end.x + ux * EXT, ey2 = end.y + uy * EXT;

  const label = attrs.number || id;

  return (
    <g data-id={id}>
      {/* Extended dashed grid line */}
      <line
        x1={ex1} y1={ey1} x2={ex2} y2={ey2}
        stroke="#ef476f" strokeWidth="var(--grid-stroke, 0.06)"
        strokeDasharray="var(--grid-dash, 0.45 0.3)"
        opacity="0.4"
      />
      {/* Hit target — wider invisible line for easier clicking */}
      <line
        x1={ex1} y1={ey1} x2={ex2} y2={ey2}
        stroke="transparent" strokeWidth="var(--grid-hit, 0.6)"
        data-id={id}
      />
      {/* Label bubble at start */}
      <g transform={`translate(${start.x},${start.y}) scale(1,-1)`}>
        <circle
          cx={0} cy={0}
          r="var(--grid-circle-r, 1.05)"
          fill="none" stroke="#ef476f" strokeWidth="var(--grid-stroke, 0.06)" opacity="0.5"
        />
        <text
          x={0} y={0}
          textAnchor="middle" dominantBaseline="central"
          fontSize="var(--grid-font, 0.84)"
          fontFamily="Inter, sans-serif" fontWeight="600"
          fill="#ef476f" opacity="0.6"
        >
          {label}
        </text>
      </g>
    </g>
  );
}
