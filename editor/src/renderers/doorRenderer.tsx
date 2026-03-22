import type { CanonicalElement, LineElement } from '../model/elements.ts';

/** Door: frame rectangle along the door line + swing arc. */
export function renderDoor(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line') return null;
  const { start, end, strokeWidth, id, attrs } = el as LineElement;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const nx = -dy / len, ny = dx / len; // perpendicular normal
  const frameDepth = 0.05;

  // Frame rectangle corners
  const p1 = `${start.x + nx * frameDepth / 2},${start.y + ny * frameDepth / 2}`;
  const p2 = `${end.x + nx * frameDepth / 2},${end.y + ny * frameDepth / 2}`;
  const p3 = `${end.x - nx * frameDepth / 2},${end.y - ny * frameDepth / 2}`;
  const p4 = `${start.x - nx * frameDepth / 2},${start.y - ny * frameDepth / 2}`;

  // Swing arc from start point, radius = door width
  const operation = attrs.operation || 'single_swing';
  const showArc = operation.includes('swing');

  return (
    <g data-id={id}>
      <polygon points={`${p1} ${p2} ${p3} ${p4}`} fill="#0077b6" stroke="none" />
      {showArc && (
        <path
          d={`M ${end.x},${end.y} A ${len},${len} 0 0 1 ${start.x + nx * len},${start.y + ny * len}`}
          fill="none" stroke="#0077b6" strokeWidth={0.02} strokeDasharray="0.06,0.04" />
      )}
    </g>
  );
}
