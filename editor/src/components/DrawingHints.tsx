import { useTranslation } from 'react-i18next';
import { useCoreEditorState, useEditorState } from '../state/EditorContext.tsx';
import type { Tool } from '../state/editorTypes.ts';
import { VERTICAL_MODE_KEY } from '../tools/drawLineTool.ts';
import { isWallDrawTable, wallDrawOptions } from '../tools/wallDrawTool.ts';
import { useModifyOptions } from '../tools/modifyOptions.ts';

const HINT_KEYS: Partial<Record<Tool, string>> = {
  draw_line:    'hint.line',
  draw_point:   'hint.point',
  draw_polygon: 'hint.polygon',
  draw_hosted:  'hint.hosted',
  draw_grid:    'hint.line',
  draw_region:  'hint.region.at_grids',
  draw_pick:    'hint.pick.slab',
  draw_section: 'hint.section',
  relocate:     'hint.relocate',
  relocate_hosted: 'hint.relocateHosted',
  rotate:       'hint.rotate',
  mirror:       'hint.mirror',
  array:        'hint.array',
  align:        'hint.align',
  offset:       'hint.offset',
  paste:        'hint.paste',
  trim_corner:  'hint.trimCorner',
  trim_single:  'hint.trimSingle',
  split:        'hint.split',
  draw_dimension: 'hint.dimension',
  draw_text:    'hint.text',
  draw_tag:     'hint.tag',
};

const VARIANT_HINTS: Record<string, string> = {
  'slab:by_walls': 'hint.pick.slab',
  'structure_slab:by_walls': 'hint.pick.slab',
  'roof:by_walls': 'hint.pick.roof',
  'ceiling:by_room': 'hint.pick.ceiling',
  'opening:sketch': 'hint.opening.sketch',
  'opening:shaft': 'hint.opening.shaft',
};

export default function DrawingHints() {
  const { t } = useTranslation();
  const { activeTool, drawingState } = useCoreEditorState();
  const { drawingAttrs, drawingTarget } = useEditorState();

  const modifyOpts = useModifyOptions();
  const hintKey = HINT_KEYS[activeTool];
  if (!hintKey) return null;
  const m = drawingState?.modify;
  const modifyHint = activeTool === 'rotate'
    ? (m?.pickCenter ? 'hint.rotateCenter' : m?.ref ? 'hint.rotate2' : 'hint.rotate')
    : activeTool === 'mirror'
      ? (modifyOpts.mirrorMode === 'draw' ? (m?.ref ? 'hint.mirrorDraw2' : 'hint.mirrorDraw') : 'hint.mirror')
      : activeTool === 'array'
        ? (modifyOpts.arrayMode === 'radial' ? 'hint.arrayRadial' : m?.ref ? 'hint.array2' : 'hint.array')
        : activeTool === 'align' && drawingState?.pick ? 'hint.align2' : null;

  // Vertical mode short-circuits the line hint with a single-click prompt.
  const isVerticalLine =
    (activeTool === 'draw_line' || activeTool === 'draw_grid')
    && drawingAttrs[VERTICAL_MODE_KEY] === 'true';
  // For polygon, show a different hint once we have 3+ points
  const isPolygonClosable = activeTool === 'draw_polygon' && drawingState && drawingState.points.length >= 3;
  const REGION_HINTS: Record<string, string> = {
    at_grids: 'hint.region.at_grids',
    between_columns: 'hint.region.between_columns',
    beam_system: 'hint.region.beam_system',
  };
  const regionHint = activeTool === 'draw_region' ? REGION_HINTS[drawingTarget?.variantId ?? ''] : undefined;
  // Wall placement: one hint per draw mode; the first trim pick has its own.
  const wallMode = activeTool === 'draw_line' && isWallDrawTable(drawingTarget?.tableName)
    ? wallDrawOptions(drawingAttrs).mode : null;
  const isWallRun = activeTool === 'draw_dimension' && drawingAttrs.dim_mode === 'wall_run';
  // Placement variants with their own hint (pick by walls / room, opening sketch / shaft).
  const variantHint = drawingTarget?.variantId ? VARIANT_HINTS[`${drawingTarget.tableName}:${drawingTarget.variantId}`] : undefined;
  const text = modifyHint
    ? t(modifyHint)
    : variantHint
    ? t(variantHint)
    : isWallRun
    ? t('hint.dimensionWallRun')
    : regionHint
      ? t(regionHint)
      : wallMode
        ? t(`hint.wall_${wallMode}`)
        : (activeTool === 'trim_corner' || activeTool === 'trim_single') && drawingState?.pick
          ? t(`${hintKey}2`)
          : isVerticalLine
            ? t('hint.vertical')
            : isPolygonClosable
              ? t('hint.polygonClose')
              : t(hintKey);

  return (
    <div className="absolute top-16 left-1/2 z-20 -translate-x-1/2 pointer-events-none animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="glass-panel rounded-lg border border-border px-3 py-1.5 shadow-[var(--shadow-panel)]">
        <span className="text-[11px] text-muted-foreground select-none">{text}</span>
      </div>
    </div>
  );
}
