import type { CanonicalElement, PolygonElement } from '../model/elements.ts';

/** Slab/stair: simple styled polygon. */
export function renderSlab(el: CanonicalElement, isStructural = false): React.JSX.Element | null {
  if (el.geometry !== 'polygon') return null;
  const { vertices, id, tableName } = el as PolygonElement;
  if (vertices.length < 3) return null;

  const structural = isStructural || tableName === 'structure_slab';
  const pts = vertices.map(v => `${v.x},${v.y}`).join(' ');
  const fill = structural ? 'rgba(141,110,99,0.08)' : 'rgba(128,128,128,0.06)';
  const stroke = structural ? '#8d6e63' : '#9e9e9e';

  return <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={0.02} data-id={id} />;
}
