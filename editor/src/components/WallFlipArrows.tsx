import { useTranslation } from 'react-i18next';
import type { DocumentState } from '../model/document.ts';
import type { LineElement } from '../model/elements.ts';
import { toElementId } from '../model/ids.ts';
import { useEditorDispatch } from '../state/EditorContext.tsx';
import { flipWalls } from '../state/typeEdits.ts';

const FLIPPABLE = new Set(['wall', 'structure_wall']);

/**
 * Revit's flip control: a double arrow on the exterior side (layer 1, the
 * wall's left) of each selected straight wall. Clicking it flips that wall.
 * `scale`: canvas scale (screen pixels per plan unit / 15, see Canvas uiScale).
 */
export default function WallFlipArrows({ document, selectedIds, scale }: {
  document: DocumentState | null;
  selectedIds: Set<string>;
  scale: number;
}) {
  const dispatch = useEditorDispatch();
  const { t } = useTranslation();
  if (!document || selectedIds.size === 0 || selectedIds.size > 40) return null;
  const walls: LineElement[] = [];
  for (const sid of selectedIds) {
    const el = document.elements.get(toElementId(sid));
    if (el && FLIPPABLE.has(el.tableName) && el.geometry === 'line' && !el.arc) walls.push(el as LineElement);
  }
  if (walls.length === 0) return null;
  const s = 1 / (15 * scale); // one screen pixel in plan units
  return (
    <g className="wall-flip-arrows" transform="scale(1,-1)">
      {walls.map(w => {
        const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return null;
        const u = { x: dx / len, y: dy / len }, n = { x: -u.y, y: u.x };
        const m = { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
        const c = { x: m.x + n.x * (w.strokeWidth / 2 + 14 * s), y: m.y + n.y * (w.strokeWidth / 2 + 14 * s) };
        const h = 6 * s, hw = 2.6 * s, head = 3 * s;
        const at = (a: number, b: number) => `${c.x + n.x * a + u.x * b},${c.y + n.y * a + u.y * b}`;
        // Double arrow across the wall: shaft along n, heads at both ends
        const d = `M${at(-h, 0)} L${at(h, 0)} M${at(h - head, -hw)} L${at(h, 0)} L${at(h - head, hw)} M${at(-h + head, -hw)} L${at(-h, 0)} L${at(-h + head, hw)}`;
        return (
          <g key={w.id} data-testid="wall-flip-arrow" style={{ cursor: 'pointer' }}
            onPointerDown={e => {
              e.stopPropagation();
              const patches = flipWalls(document.elements, [w.id]);
              if (patches.size > 0) dispatch({ type: 'APPLY_PATCH', description: 'Flip wall', patches });
            }}>
            <title>{t('ctx.flipWall')}</title>
            <circle cx={c.x} cy={c.y} r={9 * s} fill="#ffffff" fillOpacity={0.92} stroke="#3a7bff" strokeWidth={1 * s} />
            <path d={d} fill="none" stroke="#3a7bff" strokeWidth={1.6 * s} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        );
      })}
    </g>
  );
}
