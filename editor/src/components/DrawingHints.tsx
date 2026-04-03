import { useTranslation } from 'react-i18next';
import { useCoreEditorState } from '../state/EditorContext.tsx';
import type { Tool } from '../state/editorTypes.ts';

const HINT_KEYS: Partial<Record<Tool, string>> = {
  draw_line:    'hint.line',
  draw_point:   'hint.point',
  draw_polygon: 'hint.polygon',
  draw_hosted:  'hint.hosted',
  draw_grid:    'hint.line',
  relocate:     'hint.relocate',
  relocate_hosted: 'hint.relocateHosted',
  rotate:       'hint.rotate',
};

export default function DrawingHints() {
  const { t } = useTranslation();
  const { activeTool, drawingState } = useCoreEditorState();

  const hintKey = HINT_KEYS[activeTool];
  if (!hintKey) return null;

  // For polygon, show a different hint once we have 3+ points
  const isPolygonClosable = activeTool === 'draw_polygon' && drawingState && drawingState.points.length >= 3;
  const text = isPolygonClosable ? t('hint.polygonClose') : t(hintKey);

  return (
    <div className="absolute top-16 left-1/2 z-20 -translate-x-1/2 pointer-events-none animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="glass-panel rounded-lg border border-border px-3 py-1.5 shadow-[var(--shadow-panel)]">
        <span className="text-[11px] text-muted-foreground select-none">{text}</span>
      </div>
    </div>
  );
}
