import type { CanonicalElement, LineElement } from '../model/elements.ts';

/** Window: outer frame rect + two inner parallel lines representing glass. */
export function renderWindow(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line') return null;
  const { start, end, strokeWidth, id } = el as LineElement;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const nx = -dy / len, ny = dx / len; // perpendicular normal
  const hw = strokeWidth / 2;

  // Two inner lines offset from centerline
  const offset = hw * 0.35;

  // Outer rectangle corners
  const p1 = `${start.x + nx * hw},${start.y + ny * hw}`;
  const p2 = `${end.x + nx * hw},${end.y + ny * hw}`;
  const p3 = `${end.x - nx * hw},${end.y - ny * hw}`;
  const p4 = `${start.x - nx * hw},${start.y - ny * hw}`;

  return (
    <g data-id={id}>
      {/* Outer frame rectangle */}
      <polygon points={`${p1} ${p2} ${p3} ${p4}`} fill="#4a90d9" fillOpacity={0.1} stroke="#4a90d9" strokeWidth={0.02} />
      {/* Inner line 1 */}
      <line
        x1={start.x + nx * offset} y1={start.y + ny * offset}
        x2={end.x + nx * offset} y2={end.y + ny * offset}
        stroke="#4a90d9" strokeWidth={0.02} />
      {/* Inner line 2 */}
      <line
        x1={start.x - nx * offset} y1={start.y - ny * offset}
        x2={end.x - nx * offset} y2={end.y - ny * offset}
        stroke="#4a90d9" strokeWidth={0.02} />
    </g>
  );
}
