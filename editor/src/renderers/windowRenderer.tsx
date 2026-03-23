import type { CanonicalElement, LineElement } from '../model/elements.ts';
import { getBlockSvg } from './blockLoader.ts';

/** Window: rendered from block SVG, positioned along the window line. */
export function renderWindow(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line') return null;
  const { start, end, strokeWidth, id } = el as LineElement;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const svg = getBlockSvg('window');
  if (!svg) return null;

  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const hw = strokeWidth / 2;

  // Block SVG is 1×1: scale X to door length, Y to wall thickness.
  // Offset Y by -hw so the block is centered on the wall centerline.
  return (
    <g data-id={id}
      transform={`translate(${start.x},${start.y}) rotate(${angle}) translate(0,${-hw}) scale(${len},${strokeWidth})`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
