import { useMemo, Suspense } from 'react';
import { useEditorState } from '../state/EditorContext.tsx';
import type { CanonicalElement } from '../model/elements.ts';
import { parseFloorLayers } from '../model/parse.ts';
import { resolveBimMaterial } from './utils/bimMaterials.ts';
import { getRenderer } from './renderers/index.ts';
import MeshInstances from './layers/MeshInstances.tsx';
import './renderers/registerDefaults.ts';

interface FloorRenderData {
  levelId: string;
  elevation: number;
  elements: CanonicalElement[];
}

/** Parse all floors once, filter by discipline + layer visibility.
 *  For the current level, use the live document model so 3D reflects edits immediately. */
function useAllFloorsElements(): FloorRenderData[] {
  const { project, visibleLayers, activeDiscipline, document: doc, documentVersion, currentLevel } = useEditorState();

  return useMemo(() => {
    if (!project) return [];
    const result: FloorRenderData[] = [];

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

      const filtered = parsed.filter(el => {
        // Discipline filter: active discipline + architecture as context
        if (activeDiscipline !== 'architecture') {
          if (el.discipline !== activeDiscipline && el.discipline !== 'architecture') return false;
        } else {
          if (el.discipline !== 'architecture') return false;
        }
        return visibleLayers.has(`${el.discipline}/${el.tableName}`);
      });
      if (filtered.length > 0) {
        const prefixed = filtered.map(el => ({ ...el, id: `${levelId}:${el.id}` }));
        result.push({ levelId, elevation, elements: prefixed });
      }
    }
    // Global layers (e.g. mesh) — not tied to a specific floor, always visible
    if (project.globalLayers.length > 0) {
      const globalParsed = parseFloorLayers(project.globalLayers);
      const globalFiltered = globalParsed.filter(el =>
        visibleLayers.has(`${el.discipline}/${el.tableName}`),
      );
      if (globalFiltered.length > 0) {
        const prefixed = globalFiltered.map(el => ({ ...el, id: `global:${el.id}` }));
        result.push({ levelId: '__global__', elevation: 0, elements: prefixed });
      }
    }

    return result;
  }, [project, visibleLayers, activeDiscipline, doc, documentVersion, currentLevel]);
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
              levelElevation={elevation}
              levelElevations={levelElevations}
            />
          </group>
        );
      })}
    </group>
  );
}

function RenderElements({ elements, levelElevation, levelElevations, ghost }: {
  elements: CanonicalElement[];
  levelElevation: number;
  levelElevations: Map<string, number>;
  ghost?: boolean;
}) {
  const allElements = useMemo(() => {
    const map = new Map<string, CanonicalElement>();
    for (const el of elements) map.set(el.id, el);
    return map;
  }, [elements]);

  // Split elements: mesh_file → MeshInstances, rest → parametric renderers
  const { meshElements, parametricGroups } = useMemo(() => {
    const meshEls: CanonicalElement[] = [];
    const paramGroups = new Map<string, CanonicalElement[]>();
    for (const el of elements) {
      if (el.attrs.mesh_file) {
        meshEls.push(el);
      } else {
        const list = paramGroups.get(el.tableName) ?? [];
        list.push(el);
        paramGroups.set(el.tableName, list);
      }
    }
    return { meshElements: meshEls, parametricGroups: paramGroups };
  }, [elements]);

  return (
    <>
      {/* Parametric renderers */}
      {[...parametricGroups.entries()].map(([tableName, els]) => {
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
              levelElevation={levelElevation} levelElevations={levelElevations} ghost={ghost} allElements={allElements} />
          ));
        }

        return <Component key={tableName} elements={els}
          tableName={tableName} levelElevation={levelElevation}
          levelElevations={levelElevations} ghost={ghost} allElements={allElements} />;
      })}
      {/* Mesh fallback — elements with mesh_file bypass parametric rendering */}
      {meshElements.length > 0 && (
        <Suspense fallback={null}>
          <MeshInstances elements={meshElements} tableName="__mesh__"
            levelElevation={levelElevation} levelElevations={levelElevations} ghost={ghost} />
        </Suspense>
      )}
    </>
  );
}
