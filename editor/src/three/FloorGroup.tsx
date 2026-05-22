import { useMemo, Suspense } from 'react';
import { useEditorState } from '../state/EditorContext.tsx';
import { isDisciplineVisible } from '../state/selectors.ts';
import type { CanonicalElement } from '../model/elements.ts';
import type { Level } from '../types.ts';
import { parseFloorLayers } from '../model/parse.ts';
import MeshInstances from './layers/MeshInstances.tsx';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { ElementNode3D } from '../adapters/r3f/ElementNode3D.tsx';

interface FloorRenderData {
  levelId: string;
  elevation: number;
  elements: CanonicalElement[];
}

/** Parse all floors once, filter by discipline + layer visibility.
 *  For the current level, use the live document model so 3D reflects edits immediately. */
function useAllFloorsElements(): FloorRenderData[] {
  const state = useEditorState();
  const { project, visibleLayers, document: doc, documentVersion, currentLevel } = state;

  return useMemo(() => {
    if (!project) return [];
    const result: FloorRenderData[] = [];

    const isVisible = (el: CanonicalElement) =>
      isDisciplineVisible(el.discipline, state) && visibleLayers.has(`${el.discipline}/${el.tableName}`);

    // Collect all level IDs (from floors + current level if it has a document)
    const levelIds = new Set(project.floors.keys());
    if (doc && currentLevel) levelIds.add(currentLevel);

    for (const levelId of levelIds) {
      const elevation = project.levels.find(l => l.id === levelId)?.elevation ?? 0;

      // For current level with a live document, use document elements directly
      let parsed: CanonicalElement[];
      if (levelId === currentLevel && doc) {
        parsed = Array.from(doc.elements.values()).filter(el => el.tableName !== 'grid');
      } else {
        const floor = project.floors.get(levelId);
        if (!floor) continue;
        parsed = parseFloorLayers(floor.layers);
      }

      const filtered = parsed.filter(isVisible);
      if (filtered.length > 0) {
        const prefixed = filtered.map(el => ({ ...el, id: `${levelId}:${el.id}` }));
        result.push({ levelId, elevation, elements: prefixed });
      }
    }
    // Global layers (e.g. mesh) — not tied to a specific floor, always visible
    if (project.globalLayers.length > 0) {
      const globalParsed = parseFloorLayers(project.globalLayers);
      const globalFiltered = globalParsed.filter(isVisible);
      if (globalFiltered.length > 0) {
        const prefixed = globalFiltered.map(el => ({ ...el, id: `global:${el.id}` }));
        result.push({ levelId: '__global__', elevation: 0, elements: prefixed });
      }
    }

    return result;
  // state includes activeDiscipline + showArchContext used by isDisciplineVisible
  }, [project, visibleLayers, state.activeDiscipline, state.showArchContext, doc, documentVersion, currentLevel]);
}

/** Compute which levels are visible based on floor3DMode. */
function useVisibleLevels(): Set<string> {
  const { currentLevel, floor3DMode, project } = useEditorState();

  return useMemo(() => {
    if (!project) return new Set<string>();

    if (floor3DMode === 'all') {
      return new Set(project.levels.map(l => l.id));
    }

    const visible = new Set([currentLevel]);

    if (floor3DMode === 'current+below') {
      const sorted = [...project.levels].sort((a, b) => a.elevation - b.elevation);
      const idx = sorted.findIndex(l => l.id === currentLevel);
      if (idx > 0) visible.add(sorted[idx - 1].id);
    }

    return visible;
  }, [currentLevel, floor3DMode, project]);
}

export default function FloorGroup() {
  const allFloors = useAllFloorsElements();
  const visibleLevels = useVisibleLevels();

  const levelElevations = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of allFloors) map.set(f.levelId, f.elevation);
    return map;
  }, [allFloors]);

  return (
    <group>
      {allFloors.map(({ levelId, elevation, elements }) => {
        const isVisible = levelId === '__global__' || visibleLevels.has(levelId);

        return (
          <group key={levelId} visible={isVisible}>
            <RenderElements
              elements={elements}
              levelId={levelId}
              levelElevation={elevation}
              levelElevations={levelElevations}
            />
          </group>
        );
      })}
    </group>
  );
}

function RenderElements({ elements, levelId, levelElevation, levelElevations, ghost }: {
  elements: CanonicalElement[];
  levelId: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}) {
  const allElements = useMemo(() => {
    const map = new Map<string, CanonicalElement>();
    for (const el of elements) map.set(el.id, el);
    return map;
  }, [elements]);

  // Geometry context, built once per floor render pass.
  const v2Ctx = useMemo(() => {
    const level: Level = { id: levelId, number: '', name: '', elevation: levelElevation };
    const allLevels: Level[] = Array.from(levelElevations.entries()).map(
      ([id, elevation]) => ({ id, number: '', name: '', elevation }),
    );
    return buildGeometryContext({ level, allLevels, allElements });
  }, [levelId, levelElevation, levelElevations, allElements]);

  // mesh_file elements always go to MeshInstances (loads external .glb);
  // everything else goes through the V2 element-module path.
  const { meshElements, v2Elements } = useMemo(() => {
    const meshEls: CanonicalElement[] = [];
    const v2Els: CanonicalElement[] = [];
    for (const el of elements) {
      if (el.attrs.mesh_file) meshEls.push(el);
      else v2Els.push(el);
    }
    return { meshElements: meshEls, v2Elements: v2Els };
  }, [elements]);

  return (
    <>
      {v2Elements.map(el => (
        <ElementNode3D key={el.id} element={el} ctx={v2Ctx} />
      ))}
      {meshElements.length > 0 && (
        <Suspense fallback={null}>
          <MeshInstances elements={meshElements} tableName="__mesh__"
            levelElevation={levelElevation} levelElevations={levelElevations} ghost={ghost} />
        </Suspense>
      )}
    </>
  );
}
