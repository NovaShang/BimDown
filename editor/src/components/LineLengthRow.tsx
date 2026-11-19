/**
 * Length row for a selected wall-like line in the properties panel. Editing
 * it moves the wall's end along its direction (the start stays); joined walls
 * follow through RESIZE_ELEMENT's join cascade. Arc walls show it read-only.
 */
import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { toElementId } from '../model/ids.ts';
import { isJoinable, wallFrame, wallLength } from '../geometry/wallJoins.ts';
import { formatLength, getProjectUnits, getUnitSuffix } from '../utils/units.ts';
import { NumberInput } from './NumberInput.tsx';

export default function LineLengthRow({ id, editable, inputClass }: { id: string; editable: boolean; inputClass: string }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const el = state.document?.elements.get(toElementId(id));
  if (!isJoinable(el)) return null;
  const unit = getProjectUnits(state);
  const len = wallLength(el);
  const label = t('field.Length');
  const canEdit = editable && !el.arc;

  const onChange = (v: string) => {
    const L = parseFloat(v);
    const f = wallFrame(el);
    if (!f || !Number.isFinite(L) || L <= 0.01 || Math.abs(L - len) < 1e-6) return;
    dispatch({
      type: 'RESIZE_ELEMENT', id: el.id,
      changes: { end: { x: el.start.x + f.u.x * L, y: el.start.y + f.u.y * L } },
    });
  };

  return (
    <div className="px-3 pt-1" data-length-row>
      <div className="-mx-1 flex items-center gap-2 rounded-md px-1 py-[3px] transition-colors hover:bg-foreground/[0.03]">
        <span className="w-[72px] shrink-0 truncate text-[10px] text-muted-foreground" title={t('prop.lengthHint')}>{label}</span>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          {canEdit ? (
            <>
              <NumberInput className={inputClass} value={String(Math.round(len * 1000) / 1000)} onChange={onChange} step={0.01} min={0.01} />
              <span className="w-3 shrink-0 select-none text-left text-[9px] text-muted-foreground/60">{getUnitSuffix(unit).trim()}</span>
            </>
          ) : (
            <span className="truncate px-1.5 text-right text-[11px] tabular-nums text-foreground/70">{formatLength(len, unit)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
