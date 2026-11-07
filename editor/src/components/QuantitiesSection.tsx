import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorState } from '../state/EditorContext.tsx';
import { toElementId } from '../model/ids.ts';
import { getProjectUnits } from '../utils/units.ts';
import { elementQuantities } from '../schedule/quantities.ts';
import { formatCell, unitSuffix, type ColumnKind } from '../schedule/schedules.ts';
import { parseLayer } from '../model/parse.ts';
import { resolveDimension, formatDimension } from '../annotation/geometry.ts';

const ROWS: { key: 'area' | 'perimeter' | 'length' | 'height' | 'gross_area' | 'volume'; label: string; kind: ColumnKind }[] = [
  { key: 'area', label: 'schedule.col.area', kind: 'area' },
  { key: 'perimeter', label: 'schedule.col.perimeter', kind: 'length' },
  { key: 'length', label: 'schedule.col.length', kind: 'length' },
  { key: 'height', label: 'schedule.col.height', kind: 'length' },
  { key: 'gross_area', label: 'schedule.col.grossArea', kind: 'area' },
  { key: 'volume', label: 'schedule.col.volume', kind: 'volume' },
];

/** Read-only computed quantities (room area, wall length / area / volume, …) for the selected element. */
export default function QuantitiesSection({ selectionId }: { selectionId: string }) {
  const { t } = useTranslation();
  const state = useEditorState();
  const unit = getProjectUnits(state);

  const items = useMemo(() => {
    const doc = state.document;
    const project = state.project;
    if (!doc || !project) return [];
    const el = doc.elements.get(toElementId(selectionId));
    const level = project.levels.find(l => l.id === doc.levelId);
    if (!el || !level) return [];
    if (el.tableName === 'dimension') {
      const g = resolveDimension(el, id => doc.elements.get(id));
      return g ? [{ label: t('annot.measured'), value: formatDimension(g.value, unit) }] : [];
    }
    const global = project.globalLayers.flatMap(gl => parseLayer(gl));
    const q = elementQuantities(el, level, project.levels, [...doc.elements.values(), ...global]);
    // Walls: "Net area" (openings deducted) + "Gross area". Rooms: "Area" at the
    // wall faces + "Gross area (centreline)". Slabs: "Area".
    const isRoom = el.tableName === 'space';
    const isWall = !isRoom && q.gross_area !== undefined;
    const label = (r: typeof ROWS[number]) =>
      r.key === 'area' && isWall ? 'schedule.col.netArea'
        : r.key === 'gross_area' && isRoom ? 'schedule.col.grossAreaCentreline'
          : r.label;
    return ROWS.filter(r => q[r.key] !== undefined && !(r.key === 'height' && el.tableName === 'space')).map(r => ({
      label: t(label(r)),
      value: `${formatCell(q[r.key], r.kind, unit)} ${unitSuffix(r.kind, unit)}`,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionId, state.document, state.documentVersion, state.project, unit, t]);

  if (items.length === 0) return null;
  return (
    <div className="mt-1" data-testid="quantities">
      <div className="bg-foreground/[0.05] px-3 py-1.5 text-[10px] font-semibold text-foreground/65">{t('prop.Quantities')}</div>
      <div className="px-3 pb-1.5 pt-1">
        {items.map(it => (
          <div key={it.label} className="-mx-1 flex items-center gap-2 rounded-md px-1 py-[3px]">
            <span className="w-[72px] shrink-0 truncate text-[10px] text-muted-foreground" title={it.label}>{it.label}</span>
            <span className="min-w-0 flex-1 truncate px-1.5 text-right text-[11px] tabular-nums text-foreground/80">{it.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
