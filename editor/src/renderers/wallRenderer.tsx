import type { CanonicalElement, LineElement } from '../model/elements.ts';

const FILL_FN: Record<string, (m: string) => string> = {
  wall: (m) => m.includes('concrete') ? '#d4d4d4' : m.includes('metal') || m.includes('steel') ? '#e8e8e8' : '#f0f0f0',
  curtain_wall: () => '#d6eaf8',
  structure_wall: (m) => m.includes('concrete') ? '#d4d4d4' : '#e8e8e8',
  duct: () => '#00b4d815',
  pipe: () => '#06d6a015',
  conduit: () => '#ffd16615',
  cable_tray: () => '#ffd16615',
};

/** Fill-only polygon for wall/MEP lines. Outlines handled by WallOutlines. */
export function renderWallFill(el: CanonicalElement): React.JSX.Element | null {
  if (el.geometry !== 'line') return null;
  const { start, end, strokeWidth, id, tableName, attrs } = el as LineElement;
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const hw = strokeWidth / 2;
  const ext = 0.01;

  const p1 = `${start.x + nx * hw - ux * ext},${start.y + ny * hw - uy * ext}`;
  const p2 = `${end.x + nx * hw + ux * ext},${end.y + ny * hw + uy * ext}`;
  const p3 = `${end.x - nx * hw + ux * ext},${end.y - ny * hw + uy * ext}`;
  const p4 = `${start.x - nx * hw - ux * ext},${start.y - ny * hw - uy * ext}`;

  const material = (attrs.material ?? '').toLowerCase();
  const fill = (FILL_FN[tableName] ?? (() => '#eee'))(material);

  return <polygon points={`${p1} ${p2} ${p3} ${p4}`} fill={fill} stroke="none" data-id={id} />;
}
