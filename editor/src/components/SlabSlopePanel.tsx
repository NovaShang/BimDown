/**
 * Sloped floor (Revit slope arrow) on a slab / structural slab: draw the arrow
 * (tail, head) in plan, then set the top's height at the tail and the head.
 */
import { useTranslation } from 'react-i18next';
import type { PropertyPanelProps } from '../elements/archetypes.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { formatSlopeArrow, parseSlopeArrow, slopeDegrees, slopePlane } from '../geometry/slabSlope.ts';
import { startSlopeArrow } from '../tools/slopeArrowTool.ts';
import { getProjectUnits } from '../utils/units.ts';
import { NumberInput } from './NumberInput.tsx';

const INPUT = 'h-[20px] w-[64px] rounded-md border border-transparent bg-transparent px-1 text-right text-[11px] tabular-nums hover:bg-[var(--bg-input)] focus-visible:border-[var(--color-accent)] focus-visible:bg-[var(--bg-input)]';
const BTN = 'cursor-pointer rounded border border-border/60 bg-transparent px-1.5 py-0.5 text-[10px] text-foreground/80 hover:bg-foreground/[0.06]';

export default function SlabSlopePanel({ element, editable }: PropertyPanelProps) {
  const { t } = useTranslation();
  const dispatch = useEditorDispatch();
  const state = useEditorState();
  if (element.geometry !== 'polygon') return null;
  const unit = getProjectUnits(state);
  const arrow = parseSlopeArrow(element.attrs.slope_arrow);
  const setZ = (end: 'tail' | 'head', v: string) => {
    const z = parseFloat(v);
    if (!arrow || !Number.isFinite(z)) return;
    dispatch({ type: 'UPDATE_ATTRS', id: element.id, attrs: { slope_arrow: formatSlopeArrow({ ...arrow, [end]: { ...arrow[end], z } }) } });
  };
  const deg = arrow ? slopeDegrees(slopePlane(arrow)) : 0;
  return (
    <div className="mt-1" data-testid="slab-slope-panel">
      <div className="bg-foreground/[0.05] px-3 py-1.5 text-[10px] font-semibold text-foreground/65">{t('slab.slopeArrow')}</div>
      <div className="px-3 pb-1.5 pt-1">
        {!arrow && <p className="mb-1 text-[10px] leading-snug text-muted-foreground">{t('slab.slopeHint')}</p>}
        {arrow && (
          <div className="flex flex-col gap-[2px]">
            {(['tail', 'head'] as const).map(end => (
              <div key={end} className="flex items-center gap-1.5 text-[10px]" data-testid={`slab-slope-${end}`}>
                <span className="w-[76px] shrink-0 text-muted-foreground">{t(end === 'tail' ? 'slab.tailHeight' : 'slab.headHeight')}</span>
                {editable ? (
                  <NumberInput className={INPUT} value={String(arrow[end].z)} step={unit === 'mm' ? 10 : 0.01}
                    onChange={v => setZ(end, v)} />
                ) : <span className="w-[64px] text-right tabular-nums">{arrow[end].z}</span>}
                <span className="text-[9px] text-muted-foreground/60">{unit}</span>
              </div>
            ))}
            <div className="text-[10px] tabular-nums text-muted-foreground" data-testid="slab-slope-value">
              {t('slab.slopeValue', { deg: deg.toFixed(2), pct: (Math.tan((deg * Math.PI) / 180) * 100).toFixed(1) })}
            </div>
          </div>
        )}
        {editable && (
          <div className="mt-1 flex flex-wrap gap-1">
            <button type="button" className={BTN} data-testid="slab-slope-draw" onClick={() => startSlopeArrow(dispatch, element.id)}>
              {t(arrow ? 'slab.redrawArrow' : 'slab.drawArrow')}
            </button>
            {arrow && (
              <button type="button" className={BTN} data-testid="slab-slope-remove"
                onClick={() => dispatch({ type: 'UPDATE_ATTRS', id: element.id, attrs: { slope_arrow: '' } })}>
                {t('slab.removeArrow')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
