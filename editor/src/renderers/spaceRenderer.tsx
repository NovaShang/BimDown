import type { CanonicalElement, PointElement, PolygonElement } from '../model/elements.ts';
import { formatPolygonPoints } from './wallRenderer.tsx';

/** Space: render a seed point marker. */
export function renderSpace(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry === 'point') {
    // Point spaces render only via renderSpaceLabels — no geometry marker needed
    return null;
  }

  // Legacy: polygon spaces (backward compat for old data)
  if (el.geometry === 'polygon') {
    const { vertices, id } = el as PolygonElement;
    if (vertices.length < 3) return null;
    const pts = formatPolygonPoints(vertices);
    return (
      <polygon points={pts} fill="rgba(58,134,255,0.06)" stroke="#3a86ff"
        strokeWidth={0.03} strokeDasharray="0.15,0.08" data-id={id} />
    );
  }

  return null;
}

/** Render space labels as a separate overlay (above slabs). */
export function renderSpaceLabels(elements: CanonicalElement[]): React.JSX.Element[] {
  const labels: React.JSX.Element[] = [];

  for (const el of elements) {
    if (el.tableName !== 'space') continue;

    let cx: number, cy: number;

    if (el.geometry === 'point') {
      const pt = el as PointElement;
      cx = pt.position.x;
      cy = pt.position.y;
    } else if (el.geometry === 'polygon') {
      const poly = el as PolygonElement;
      if (poly.vertices.length < 3) continue;
      const c = centroid(poly.vertices);
      cx = c.x;
      cy = c.y;
    } else {
      continue;
    }

    const { id, attrs } = el;
    const number = attrs.number || '';
    const name = attrs.name || '';
    if (!number && !name) continue;

    labels.push(
      <g key={id} data-id={id}>
        {number && (
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
            fontSize={0.4} fontFamily="Inter, sans-serif" fontWeight={700} fill="#3a86ff"
            transform={`translate(${cx},${cy}) scale(1,-1) translate(${-cx},${-cy})`}>
            {number}
          </text>
        )}
        {name && (
          <text x={cx} y={cy - 0.45} textAnchor="middle" dominantBaseline="central"
            fontSize={0.22} fontFamily="Inter, sans-serif" fontWeight={500} fill="#5a9fff"
            transform={`translate(${cx},${cy - 0.45}) scale(1,-1) translate(${-cx},${-(cy - 0.45)})`}>
            {name}
          </text>
        )}
      </g>
    );
  }

  return labels;
}

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
