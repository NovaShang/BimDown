import { useMemo } from 'react';
import { useEditorState } from '../state/EditorContext.tsx';
import type { CanonicalElement } from '../model/elements.ts';
import BoxInstances from './layers/BoxInstances.tsx';
import PolygonExtrusions from './layers/PolygonExtrusions.tsx';
import { useFloorElements } from './hooks/useFloorElements.ts';

const BOX_TABLES = new Set([
  'wall', 'structure_wall', 'door', 'window',
  'duct', 'pipe', 'conduit', 'cable_tray', 'beam', 'brace',
  'column', 'structure_column', 'equipment', 'terminal',
]);
const POLYGON_TABLES = new Set(['space', 'slab', 'structure_slab', 'stair']);

export default function FloorGroup() {
  const state = useEditorState();
  const elements = useFloorElements();
  const levels = state.project?.levels ?? [];
  const currentLevel = state.currentLevel;

  // Build level elevation map
  const levelElevations = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of levels) map.set(l.id, l.elevation);
    return map;
  }, [levels]);

  const currentElevation = levelElevations.get(currentLevel) ?? 0;

  // Group elements by tableName
  const grouped = useMemo(() => {
    const map = new Map<string, CanonicalElement[]>();
    for (const el of elements) {
      const list = map.get(el.tableName) ?? [];
      list.push(el);
      map.set(el.tableName, list);
    }
    return map;
  }, [elements]);

  return (
    <group>
      {[...grouped.entries()].map(([tableName, els]) => {
        if (BOX_TABLES.has(tableName)) {
          return (
            <BoxInstances
              key={tableName}
              elements={els}
              tableName={tableName}
              levelElevation={currentElevation}
              levelElevations={levelElevations}
            />
          );
        }
        if (POLYGON_TABLES.has(tableName)) {
          return (
            <PolygonExtrusions
              key={tableName}
              elements={els}
              tableName={tableName}
              levelElevation={currentElevation}
              levelElevations={levelElevations}
            />
          );
        }
        return null;
      })}
    </group>
  );
}
