import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { getBlockSvg } from './blockLoader.ts';

const BLOCK_MAP: Record<string, string> = {
  single_swing: 'door_single_swing',
  double_swing: 'door_double_swing',
  sliding: 'door_sliding',
  folding: 'door_folding',
};

/** Door: rendered from block SVG, positioned and scaled along the door line. */
export function renderDoor(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line') return null;
  const { start, end, strokeWidth, id, attrs } = el as LineElement;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const operation = attrs.operation || 'single_swing';
  const blockName = BLOCK_MAP[operation] ?? 'door_single_swing';
  const svg = getBlockSvg(blockName);
  if (!svg) return null;

  // Transform: translate to start point, rotate to align with door direction, scale to door width
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  return (
    <g data-id={id}
      transform={`translate(${start.x},${start.y}) rotate(${angle}) scale(${len},${len})`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
