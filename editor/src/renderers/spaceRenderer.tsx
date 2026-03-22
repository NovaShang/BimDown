import type { CanonicalElement, PolygonElement } from '../model/elements.ts';

function centroid(vertices: { x: number; y: number }[]): { x: number; y: number } {
  let area = 0, cx = 0, cy = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-10) {
    const sx = vertices.reduce((s, v) => s + v.x, 0) / n;
    const sy = vertices.reduce((s, v) => s + v.y, 0) / n;
    return { x: sx, y: sy };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

/** Space: dashed polygon boundary + number/name labels at centroid. */
export function renderSpace(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'polygon') return null;
  const { vertices, id, attrs } = el as PolygonElement;
  if (vertices.length < 3) return null;

  const pts = vertices.map(v => `${v.x},${v.y}`).join(' ');
  const c = centroid(vertices);
  const number = attrs.number || '';
  const name = attrs.name || '';

  return (
    <g data-id={id}>
      <polygon points={pts} fill="rgba(58,134,255,0.06)" stroke="#3a86ff" strokeWidth={0.03} strokeDasharray="0.15,0.08" />
      {number && (
        <text x={c.x} y={-c.y} textAnchor="middle" dominantBaseline="central"
          fontSize={0.4} fontFamily="Inter, sans-serif" fontWeight={700} fill="#1e3a5f"
          transform={`scale(1,-1) translate(0,${-2 * c.y})`}>
          {number}
        </text>
      )}
      {name && (
        <text x={c.x} y={-c.y + 0.45} textAnchor="middle" dominantBaseline="central"
          fontSize={0.22} fontFamily="Inter, sans-serif" fontWeight={400} fill="#4a6fa5"
          transform={`scale(1,-1) translate(0,${-2 * c.y + 0.9})`}>
          {name}
        </text>
      )}
    </g>
  );
}
