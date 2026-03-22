import type { CanonicalElement, LineElement } from '../model/elements.ts';

/** Door: frame rect + swing arc. */
export function renderDoor(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line') return null;
  const { start, strokeWidth, id, attrs } = el as LineElement;
  const hw = strokeWidth / 2;
  const operation = attrs.operation || 'single_swing';

  const r = hw;
  const showArc = operation.includes('swing');
  const arcD = `M ${start.x - r},${start.y} A ${r},${r} 0 0 1 ${start.x},${start.y + r}`;

  return (
    <g data-id={id}>
      <rect x={start.x - hw} y={start.y - 0.025} width={strokeWidth} height={0.05} fill="#0077b6" />
      {showArc && (
        <path d={arcD} fill="none" stroke="#0077b6" strokeWidth={0.02} strokeDasharray="0.06,0.04" />
      )}
    </g>
  );
}
