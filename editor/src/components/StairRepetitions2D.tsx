import { memo, useMemo, type ReactNode } from 'react';
import { useCoreEditorState } from '../state/EditorContext.tsx';
import { getElementModule } from '../elements/registry.ts';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { stairsRepeatingOn } from '../geometry/stairRepeats.ts';

/**
 * Multi-storey stairs of lower levels drawn on the storeys they repeat on
 * (read-only, slightly faded: they are edited on their own level).
 */
const StairRepetitions2D = memo(function StairRepetitions2D() {
  const { project, currentLevel, viewMode } = useCoreEditorState();
  const drawn = useMemo(() => {
    if (viewMode !== '2d' || !currentLevel) return [];
    const out: ReactNode[] = [];
    for (const { level, elements } of stairsRepeatingOn(project, currentLevel)) {
      const ctx = buildGeometryContext({
        level, allLevels: project!.levels, allElements: new Map(elements.map(e => [e.id, e])),
        mepSystems: project!.mepSystems, types: project!.types,
      });
      for (const el of elements) {
        const mod = getElementModule(el.tableName);
        const facts = mod?.geometry(el, ctx);
        if (!mod || !facts) continue;
        const g = mod.draw2D(facts, { elementId: el.id, selected: false, hovered: false, scale: 1, levelElevation: ctx.levelElevation });
        if (g) out.push(<g key={`${level.id}:${el.id}`} transform="scale(1,-1)" data-repeat-of={`${level.id}:${el.id}`}>{g}</g>);
      }
    }
    return out;
  }, [project, currentLevel, viewMode]);
  if (drawn.length === 0) return null;
  return <g className="stair-repetitions" style={{ pointerEvents: 'none', opacity: 0.6 }}>{drawn}</g>;
});

export default StairRepetitions2D;
