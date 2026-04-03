import type { CanonicalElement, PointElement } from '../model/elements.ts';
import { getBlockSvg } from './blockLoader.ts';

const BLOCK_MAP: Record<string, string> = {
  rect: 'column_rectangular',
  round: 'column_round',
};

/** Column: rendered from block SVG, positioned and scaled to actual size. */
export function renderColumn(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'point') return null;
  const { position, width, height, id, attrs } = el as PointElement;

  const shape = attrs.shape || 'rect';
  const blockName = BLOCK_MAP[shape] ?? 'column_rectangular';
  const svg = getBlockSvg(blockName);
  if (!svg) return null;

  // Block SVG is 1×1: scale to actual width/height, rotate around center
  const rotation = parseFloat(attrs.rotation || '0');

  return (
    <g data-id={id}
      transform={`translate(${position.x},${position.y}) rotate(${rotation}) translate(${-width / 2},${-height / 2}) scale(${width},${height})`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
