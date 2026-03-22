import { useMemo } from 'react';
import { useEditorState } from '../state/EditorContext.tsx';
import type { CanonicalElement } from '../model/elements.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { useFloorElements } from './hooks/useFloorElements.ts';
import { resolveBimMaterial } from './utils/bimMaterials.ts';
import { getRenderer } from './renderers/index.ts';
import './renderers/registerDefaults.ts';

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
  const activeDiscipline = state.activeDiscipline;

  const levelElevations = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of levels) map.set(l.id, l.elevation);
    return map;
  }, [levels]);

  const allFloorsData = useMemo(() => {
    if (!isAllFloors || !state.project) return null;
    const { activeDiscipline, visibleLayers } = state;
    const result: FloorRenderData[] = [];

    for (const [levelId, floor] of state.project.floors) {
      const elevation = levelElevations.get(levelId) ?? 0;
      const parsed = parseFloorLayers(floor.layers);
      const filtered = parsed.filter(el => {
        if (activeDiscipline !== 'architechture') {
          if (el.discipline !== activeDiscipline) return false;
        } else {
          if (el.discipline !== 'architechture') return false;
        }
        return visibleLayers.has(`${el.discipline}/${el.tableName}`);
      });
      if (filtered.length > 0) {
        const prefixed = filtered.map(el => ({ ...el, id: `${levelId}:${el.id}` }));
        result.push({ levelId, elevation, elements: prefixed });
      }
    }
    return result;
  }, [isAllFloors, state.project, state.activeDiscipline, state.visibleLayers, levelElevations]);

  const isNonArchDiscipline = !isAllFloors && activeDiscipline !== 'architechture';

  const { activeElements, ghostElements } = useMemo(() => {
    if (!isNonArchDiscipline) return { activeElements: singleFloorElements, ghostElements: [] };
    const active: CanonicalElement[] = [];
    const ghost: CanonicalElement[] = [];
    for (const el of singleFloorElements) {
      if (el.discipline === 'architechture') ghost.push(el);
      else active.push(el);
    }
    return { activeElements: active, ghostElements: ghost };
  }, [singleFloorElements, isNonArchDiscipline]);

  if (!isAllFloors) {
    const currentElevation = levelElevations.get(currentLevel) ?? 0;
    return (
      <group>
        {ghostElements.length > 0 && (
          <RenderElements elements={ghostElements} levelElevation={currentElevation} levelElevations={levelElevations} ghost />
        )}
        <RenderElements elements={activeElements} levelElevation={currentElevation} levelElevations={levelElevations} />
      </group>
    );
  }

  if (!allFloorsData) return null;
  return (
    <group>
      {allFloorsData.map(({ levelId, elevation, elements }) => (
        <RenderElements key={levelId} elements={elements} levelElevation={elevation} levelElevations={levelElevations} />
      ))}
    </group>
  );
}

function RenderElements({ elements, levelElevation, levelElevations, ghost }: {
  elements: CanonicalElement[];
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
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
        const config = getRenderer(tableName);
        if (!config) return null;
        const Component = config.component;

        if (config.groupByMaterial) {
          const byMat = new Map<string, CanonicalElement[]>();
          for (const el of els) {
            const mat = resolveBimMaterial(el.attrs.material, tableName);
            const list = byMat.get(mat) ?? [];
            list.push(el);
            byMat.set(mat, list);
          }
          return [...byMat.entries()].map(([mat, matEls]) => (
            <Component key={`${tableName}:${mat}`} elements={matEls}
              tableName={tableName} materialName={mat}
              levelElevation={levelElevation} levelElevations={levelElevations} ghost={ghost} />
          ));
        }

        return <Component key={tableName} elements={els}
          tableName={tableName} levelElevation={levelElevation}
          levelElevations={levelElevations} ghost={ghost} />;
      })}
    </>
  );
}
