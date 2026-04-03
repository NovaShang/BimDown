import type { CanonicalElement, PointElement } from '../model/elements.ts';

/** Equipment/terminal: rounded filled rect. */
export function renderEquipment(el: CanonicalElement, isTerminal = false): React.JSX.Element | null {
  if (el.geometry !== 'point') return null;
  const { position, width, height, id, tableName } = el as PointElement;
  const terminal = isTerminal || tableName === 'terminal';
  const color = terminal ? '#f77f00' : '#e63946';

  const rotation = parseFloat((el as PointElement).attrs.rotation || '0');

  return (
    <g data-id={id} transform={`translate(${position.x},${position.y}) rotate(${rotation})`}>
      <rect x={-width / 2} y={-height / 2} width={width} height={height}
        fill={color + '30'} stroke={color} strokeWidth={0.02}
        rx={0.03} ry={0.03} />
    </g>
  );
}
