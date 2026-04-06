import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';

// ─── Shared 2D helpers ──────────────────────────────────────────────

/** Format polygon vertices as an SVG points attribute string. */
export function formatPolygonPoints(vertices: Point[]): string {
  return vertices.map(v => `${v.x},${v.y}`).join(' ');
}

/** Resolve a fill color from table name + material string (used by wall fills & line fills). */
export function getMaterialFill(tableName: string, material: string): string {
  const m = material.toLowerCase();
  switch (tableName) {
    case 'curtain_wall': return '#d6eaf8';
    case 'wall':
    case 'structure_wall':
      if (m.includes('concrete')) return '#d4d4d4';
      if (m.includes('metal') || m.includes('steel')) return '#e8e8e8';
      return '#f0f0f0';
    case 'stair': return '#e0d8cf';
    case 'beam':
    case 'brace':
      return m.includes('concrete') ? '#d4d4d4' : '#e8e8e8';
    case 'ramp': return '#e8e8e8';
    case 'railing': return '#cccccc';
    case 'room_separator': return '#ddd';
    default: return '#eee';
  }
}

/** Render a line element as a filled polygon (4-corner quad from line thickness). */
export function renderLinePolygon(el: LineElement, fill: string): React.JSX.Element | null {
  const { start, end, strokeWidth, id } = el;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const nx = -dy / len, ny = dx / len;
  const hw = strokeWidth / 2;

  const p1 = `${start.x + nx * hw},${start.y + ny * hw}`;
  const p2 = `${end.x + nx * hw},${end.y + ny * hw}`;
  const p3 = `${end.x - nx * hw},${end.y - ny * hw}`;
  const p4 = `${start.x - nx * hw},${start.y - ny * hw}`;

  return <polygon points={`${p1} ${p2} ${p3} ${p4}`} fill={fill} stroke="none" data-id={id} />;
}

/**
 * Transparent hit-area polygon for wall/MEP lines whose visible fill
 * is rendered by WallOutlines (with miter-adjusted corners).
 */
export function renderWallHitArea(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  return renderLinePolygon(el as LineElement, 'transparent');
}

/**
 * Visible fill polygon for non-miter line elements (stair, beam, brace, etc.).
 */
export function renderLineFill(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  const line = el as LineElement;
  const fill = getMaterialFill(el.tableName, line.attrs.material ?? '');
  return renderLinePolygon(line, fill);
}
