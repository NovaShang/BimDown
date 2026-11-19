/**
 * Wall "Attach Top" (Revit): pick a roof or slab, on any level, whose
 * underside the wall top follows wherever the wall is under it.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PropertyPanelProps } from '../elements/archetypes.ts';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { crossLevelIndex } from '../model/crossLevel.ts';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select';

const NONE = '__none__';
const SELECT = 'h-[22px] min-w-0 flex-1 gap-0.5 rounded-md border border-transparent bg-transparent px-1.5 text-left text-[11px] hover:bg-[var(--bg-input)]';

export default function WallAttachPanel({ element, editable }: PropertyPanelProps) {
  const { t } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const { project, document: liveDoc, currentLevel } = state;
  const index = useMemo(
    () => crossLevelIndex(project, liveDoc ? { levelId: currentLevel, elements: liveDoc.elements } : null),
    [project, liveDoc, currentLevel],
  );
  if (element.geometry !== 'line' && element.geometry !== 'spatial_line') return null;
  const levelName = (id: string) => project?.levels.find(l => l.id === id)?.name || id;
  const own = project?.levels.find(l => l.id === currentLevel)?.elevation ?? 0;
  // Roofs / slabs on this level or above.
  const targets = (index?.attachTargets ?? []).filter(e => e.elevation >= own - 1e-6);
  const value = element.attrs.top_attach_id || NONE;
  const labelOf = (id: string) => {
    const e = targets.find(x => x.el.id === id) ?? index?.find(id);
    if (!e) return id;
    return `${t(`layer.${e.el.tableName}`)} ${e.el.attrs.number || e.el.id} · ${levelName(e.levelId)}`;
  };
  return (
    <div className="mt-1" data-testid="wall-attach-panel">
      <div className="bg-foreground/[0.05] px-3 py-1.5 text-[10px] font-semibold text-foreground/65">{t('wall.attachTop')}</div>
      <div className="px-3 pb-1.5 pt-1">
        <div className="flex items-center gap-2">
          <Select value={value} disabled={!editable}
            onValueChange={v => { if (v) dispatch({ type: 'UPDATE_ATTRS', id: element.id, attrs: { top_attach_id: v === NONE ? '' : String(v) } }); }}>
            <SelectTrigger className={SELECT} data-testid="wall-attach-select">
              <span className="truncate">{value === NONE ? t('wall.notAttached') : labelOf(value)}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('wall.notAttached')}</SelectItem>
              {targets.map(e => <SelectItem key={`${e.levelId}/${e.el.id}`} value={e.el.id}>{labelOf(e.el.id)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{t('wall.attachHint')}</p>
      </div>
    </div>
  );
}
