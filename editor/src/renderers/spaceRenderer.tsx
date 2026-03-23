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

/** Space polygon only (no text). Text labels rendered separately in SpaceLabels overlay. */
export function renderSpace(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'polygon') return null;
  const { vertices, id } = el as PolygonElement;
  if (vertices.length < 3) return null;

  const pts = vertices.map(v => `${v.x},${v.y}`).join(' ');

  return (
    <polygon points={pts} fill="rgba(58,134,255,0.06)" stroke="#3a86ff"
      strokeWidth={0.03} strokeDasharray="0.15,0.08" data-id={id} />
  );
}

/** Render space labels as a separate overlay (above slabs). */
export function renderSpaceLabels(elements: CanonicalElement[]): React.JSX.Element[] {
  const labels: React.JSX.Element[] = [];

  for (const el of elements) {
    if (el.geometry !== 'polygon' || el.tableName !== 'space') continue;
    const { vertices, id, attrs } = el as PolygonElement;
    if (vertices.length < 3) continue;

    const c = centroid(vertices);
    const number = attrs.number || '';
    const name = attrs.name || '';
    if (!number && !name) continue;

    labels.push(
      <g key={id} data-id={id}>
        {number && (
          <text x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central"
            fontSize={0.4} fontFamily="Inter, sans-serif" fontWeight={700} fill="#3a86ff"
            transform={`translate(${c.x},${c.y}) scale(1,-1) translate(${-c.x},${-c.y})`}>
            {number}
          </text>
        )}
        {name && (
          <text x={c.x} y={c.y - 0.45} textAnchor="middle" dominantBaseline="central"
            fontSize={0.22} fontFamily="Inter, sans-serif" fontWeight={500} fill="#5a9fff"
            transform={`translate(${c.x},${c.y - 0.45}) scale(1,-1) translate(${-c.x},${-(c.y - 0.45)})`}>
            {name}
          </text>
        )}
      </g>
    );
  }

  return labels;
}
