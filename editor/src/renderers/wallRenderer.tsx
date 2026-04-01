import type { CanonicalElement, LineElement } from '../model/elements.ts';

const FILL_FN: Record<string, (m: string) => string> = {
  stair: () => '#e0d8cf',
  beam: (m) => m.includes('concrete') ? '#d4d4d4' : '#e8e8e8',
  brace: (m) => m.includes('concrete') ? '#d4d4d4' : '#e8e8e8',
  ramp: () => '#e8e8e8',
  railing: () => '#cccccc',
  room_separator: () => '#ddd',
};

function renderLinePolygon(el: LineElement, fill: string): React.JSX.Element | null {
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
  const material = ((el as LineElement).attrs.material ?? '').toLowerCase();
  const fill = (FILL_FN[el.tableName] ?? (() => '#eee'))(material);
  return renderLinePolygon(el as LineElement, fill);
}
