import React, { useMemo } from 'react';
import { useCoreEditorState } from '../state/EditorContext.tsx';
import { SVGGeometryProvider, useGeometryContext } from '../adapters/svg/context.tsx';
import { parseFloorLayers } from '../model/parse.ts';
import { getElementModule } from '../elements/registry.ts';
import type { CanonicalElement } from '../model/elements.ts';
import type { Level } from '../types.ts';

/** What the level below shows as underlay: its walls, openings, columns, stairs. */
const UNDERLAY_TABLES = new Set([
  'wall', 'curtain_wall', 'structure_wall', 'door', 'window', 'opening',
  'column', 'structure_column', 'stair', 'stair_run', 'stair_landing', 'railing', 'ramp',
]);

/** The level drawn as underlay under `current`: the next one down (Revit's default "Underlay: level below"). */
export function underlayLevelOf(levels: readonly Level[], current: string): Level | null {
  const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
  const i = sorted.findIndex(l => l.id === current);
  return i > 0 ? sorted[i - 1] : null;
}

/**
 * Revit's plan underlay: the level below drawn halftone under the current
 * level, never picked or snapped to.
 */
export default function LevelUnderlay2D() {
  const state = useCoreEditorState();
  const on = state.viewOptions?.showLevelBelow ?? false;
  const levels = state.project?.levels ?? [];
  const below = on ? underlayLevelOf(levels, state.currentLevel) : null;
  const floor = below ? state.project?.floors.get(below.id) : undefined;
  const elements = useMemo(() => {
    if (!floor) return null;
    const map = new Map<string, CanonicalElement>();
    for (const el of parseFloorLayers(floor.layers)) map.set(el.id, el);
    return map;
  }, [floor]);
  if (!below || !elements || elements.size === 0) return null;
  return (
    <g className="level-underlay" pointerEvents="none" opacity={0.28} style={{ filter: 'grayscale(1)' }} data-underlay-level={below.id}>
      <SVGGeometryProvider level={below} allLevels={levels as Level[]} allElements={elements} mepSystems={state.project?.mepSystems} types={state.project?.types}>
        <UnderlayElements elements={elements} />
      </SVGGeometryProvider>
    </g>
  );
}

const UnderlayElements = React.memo(function UnderlayElements({ elements }: { elements: Map<string, CanonicalElement> }) {
  const ctx = useGeometryContext();
  if (!ctx) return null;
  const out: React.ReactNode[] = [];
  for (const el of elements.values()) {
    if (!UNDERLAY_TABLES.has(el.tableName)) continue;
    const mod = getElementModule(el.tableName);
    const facts = mod?.geometry(el, ctx);
    if (!mod || facts == null) continue;
    const node = mod.draw2D(facts, { elementId: el.id, selected: false, hovered: false, scale: 1 });
    if (node) out.push(<g key={el.id}>{node}</g>);
  }
  return <g transform="scale(1,-1)">{out}</g>;
});
