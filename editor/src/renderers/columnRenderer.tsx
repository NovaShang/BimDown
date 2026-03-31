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

  // Block SVG is 1×1: scale to actual width/height, translate to top-left corner
  const x = position.x - width / 2;
  const y = position.y - height / 2;

  return (
    <g data-id={id}
      transform={`translate(${x},${y}) scale(${width},${height})`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
