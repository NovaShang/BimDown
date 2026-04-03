import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { getBlockSvg } from './blockLoader.ts';

const BLOCK_MAP: Record<string, string> = {
  single_swing: 'door_single_swing',
  double_swing: 'door_double_swing',
  sliding: 'door_sliding',
  folding: 'door_folding',
};

/** Door: block SVG positioned along door line, with hinge/swing flips. */
export function renderDoor(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line') return null;
  const { start, end, id, attrs } = el as LineElement;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const operation = attrs.operation || 'single_swing';
  const blockName = BLOCK_MAP[operation] ?? 'door_single_swing';
  const svg = getBlockSvg(blockName);
  if (!svg) return null;

  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  // Hinge at 'end' → flip block along door line (mirror X)
  const hingeEnd = attrs.hinge_position === 'end';
  // Swing 'right' (facing start→end) → flip perpendicular to door line (mirror Y)
  const swingRight = attrs.swing_side === 'right';

  const sx = hingeEnd ? -1 : 1;
  const sy = swingRight ? -1 : 1;
  // When flipping X, shift origin so the block stays within start→end
  const tx = hingeEnd ? 1 : 0;

  return (
    <g data-id={id}
      transform={`translate(${start.x},${start.y}) rotate(${angle}) scale(${len},${len}) translate(${tx},0) scale(${sx},${sy})`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
