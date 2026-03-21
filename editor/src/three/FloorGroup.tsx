import { useMemo } from 'react';
import { useEditorState } from '../state/EditorContext.tsx';
import type { CanonicalElement } from '../model/elements.ts';
import { parseFloorLayers } from '../model/parse.ts';
import BoxInstances from './layers/BoxInstances.tsx';
import PolygonExtrusions from './layers/PolygonExtrusions.tsx';
import { useFloorElements } from './hooks/useFloorElements.ts';

const BOX_TABLES = new Set([
  'wall', 'structure_wall', 'door', 'window',
  'duct', 'pipe', 'conduit', 'cable_tray', 'beam', 'brace',
  'column', 'structure_column', 'equipment', 'terminal',
]);
const POLYGON_TABLES = new Set(['space', 'slab', 'structure_slab', 'stair']);

interface FloorRenderData {
  levelId: string;
  elevation: number;
  elements: CanonicalElement[];
}

export default function FloorGroup() {
  const state = useEditorState();
  const singleFloorElements = useFloorElements();
  const levels = state.project?.levels ?? [];
  const currentLevel = state.currentLevel;
  const isAllFloors = currentLevel === '__all__';

  const levelElevations = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of levels) map.set(l.id, l.elevation);
    return map;
  }, [levels]);

  // For all-floors mode: parse every floor and collect elements with discipline filtering
  const allFloorsData = useMemo(() => {
    if (!isAllFloors || !state.project) return null;
    const { activeDiscipline, visibleLayers } = state;
    const result: FloorRenderData[] = [];

    for (const [levelId, floor] of state.project.floors) {
      const elevation = levelElevations.get(levelId) ?? 0;
      const parsed = parseFloorLayers(floor.layers);
      const filtered = parsed.filter(el => {
        // Non-architectural discipline: only show that discipline, no arch background
        if (activeDiscipline !== 'architectural') {
          if (el.discipline !== activeDiscipline) return false;
        } else {
          // Architectural: show only architectural
          if (el.discipline !== 'architectural') return false;
        }
        return visibleLayers.has(`${el.discipline}/${el.tableName}`);
      });
      if (filtered.length > 0) {
        // Prefix IDs with levelId to avoid collisions across floors
        const prefixed = filtered.map(el => ({ ...el, id: `${levelId}:${el.id}` }));
        result.push({ levelId, elevation, elements: prefixed });
      }
    }
    return result;
  }, [isAllFloors, state.project, state.activeDiscipline, state.visibleLayers, levelElevations]);

  // Single floor mode
  if (!isAllFloors) {
    const currentElevation = levelElevations.get(currentLevel) ?? 0;
    return (
      <group>
        <RenderElements elements={singleFloorElements} levelElevation={currentElevation} levelElevations={levelElevations} />
      </group>
    );
  }

  // All floors mode
  if (!allFloorsData) return null;
  return (
    <group>
      {allFloorsData.map(({ levelId, elevation, elements }) => (
        <RenderElements key={levelId} elements={elements} levelElevation={elevation} levelElevations={levelElevations} />
      ))}
    </group>
  );
}

function RenderElements({ elements, levelElevation, levelElevations }: {
  elements: CanonicalElement[];
  levelElevation: number;
  levelElevations: Map<string, number>;
}) {
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
    <>
      {[...grouped.entries()].map(([tableName, els]) => {
        if (BOX_TABLES.has(tableName)) {
          return (
            <BoxInstances
              key={tableName}
              elements={els}
              tableName={tableName}
              levelElevation={levelElevation}
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
              levelElevation={levelElevation}
              levelElevations={levelElevations}
            />
          );
        }
        return null;
      })}
    </>
  );
}
