import type { CanonicalElement, PointElement } from '../model/elements.ts';

/** Column: filled rect with diagonal cross lines. */
export function renderColumn(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'point') return null;
  const { position, width, height, id, tableName } = el as PointElement;
  const isStructural = tableName === 'structure_column';
  const color = isStructural ? '#6d4c41' : '#333';
  const fill = isStructural ? '#d7ccc8' : '#e0e0e0';

  const x = position.x - width / 2, y = position.y - height / 2;

  return (
    <g data-id={id}>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke={color} strokeWidth={0.02} />
      <line x1={x} y1={y} x2={x + width} y2={y + height} stroke={color} strokeWidth={0.015} />
      <line x1={x + width} y1={y} x2={x} y2={y + height} stroke={color} strokeWidth={0.015} />
    </g>
  );
}
