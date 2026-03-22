import type { CanonicalElement, PointElement } from '../model/elements.ts';

/** Equipment/terminal: rounded filled rect. */
export function renderEquipment(el: CanonicalElement, isTerminal = false): React.JSX.Element | null {
  if (el.geometry !== 'point') return null;
  const { position, width, height, id, tableName } = el as PointElement;
  const terminal = isTerminal || tableName === 'terminal';
  const color = terminal ? '#f77f00' : '#e63946';

  const x = position.x - width / 2, y = position.y - height / 2;

  return (
    <rect x={x} y={y} width={width} height={height}
      fill={color + '30'} stroke={color} strokeWidth={0.02}
      rx={0.03} ry={0.03} data-id={id} />
  );
}
