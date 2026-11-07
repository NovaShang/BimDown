import { memo, useMemo, useLayoutEffect, useRef, useState, Suspense } from 'react';
import { Group } from 'three';
import { createPortal } from '@react-three/fiber';
import { useEditorState, useSelectionState } from '../state/EditorContext.tsx';
import { isLayerVisibleInView } from '../state/selectors.ts';
import type { CanonicalElement } from '../model/elements.ts';
import type { Level } from '../types.ts';
import { parseFloorLayers } from '../model/parse.ts';
import MeshInstances from './layers/MeshInstances.tsx';
import { buildGeometryContext } from '../adapters/svg/buildContext.ts';
import { ElementNode3D, ElementHighlight3D } from '../adapters/r3f/ElementNode3D.tsx';
import type { GeometryContext } from '../elements/archetypes.ts';
import { buildStaticBatch, releaseStaticBatch } from './staticBatch.ts';

interface FloorRenderData {
  levelId: string;
  elevation: number;
  elements: CanonicalElement[];
}

interface FloorCacheEntry {
  source: unknown;
  visibleLayers: Set<string>;
  discipline: string | null;
  archContext: boolean;
  viewOptions: unknown;
  elevation: number;
  data: FloorRenderData | null;
}

/** Parse all floors, filter by discipline + layer visibility.
 *  For the current level, use the live document model so 3D reflects edits immediately.
 *  Each floor's result is kept until its source (floor data or document) or the
 *  visibility settings change, so switching level or editing one floor doesn't
 *  rebuild the others. */
function useAllFloorsElements(): FloorRenderData[] {
  const state = useEditorState();
  const { project, visibleLayers, document: doc, documentVersion, currentLevel } = state;
  // Mutable per-component cache (a stable Map, not React state).
  const [cache] = useState(() => new Map<string, FloorCacheEntry>());

  return useMemo(() => {
    if (!project) return [];
    const result: FloorRenderData[] = [];
    const seen = new Set<string>();

    const isVisible = (el: CanonicalElement) =>
      isLayerVisibleInView(el.discipline, el.tableName, state) && visibleLayers.has(`${el.discipline}/${el.tableName}`);

    const floorData = (levelId: string, elevation: number, source: unknown, parse: () => CanonicalElement[]) => {
      seen.add(levelId);
      const hit = cache.get(levelId);
      if (hit && hit.source === source && hit.visibleLayers === visibleLayers && hit.elevation === elevation
        && hit.discipline === state.activeDiscipline && hit.archContext === state.showArchContext
        && hit.viewOptions === state.viewOptions) {
        return hit.data;
      }
      const filtered = parse().filter(isVisible);
      const data = filtered.length > 0
        ? { levelId, elevation, elements: filtered.map(el => ({ ...el, id: `${levelId === '__global__' ? 'global' : levelId}:${el.id}` })) }
        : null;
      cache.set(levelId, {
        source, visibleLayers, elevation, data,
        discipline: state.activeDiscipline, archContext: state.showArchContext, viewOptions: state.viewOptions,
      });
      return data;
    };

    // Collect all level IDs (from floors + current level if it has a document)
    const levelIds = new Set(project.floors.keys());
    if (doc && currentLevel) levelIds.add(currentLevel);

    for (const levelId of levelIds) {
      const elevation = project.levels.find(l => l.id === levelId)?.elevation ?? 0;

      // For current level with a live document, use document elements directly
      let data: FloorRenderData | null;
      if (levelId === currentLevel && doc) {
        data = floorData(levelId, elevation, doc.elements,
          () => Array.from(doc.elements.values()).filter(el => el.tableName !== 'grid'));
      } else {
        const floor = project.floors.get(levelId);
        if (!floor) continue;
        data = floorData(levelId, elevation, floor, () => parseFloorLayers(floor.layers));
      }
      if (data) result.push(data);
    }
    // Global layers (e.g. mesh) — not tied to a specific floor, always visible
    if (project.globalLayers.length > 0) {
      const data = floorData('__global__', 0, project.globalLayers, () => parseFloorLayers(project.globalLayers));
      if (data) result.push(data);
    }
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);

    return result;
  // state includes activeDiscipline + showArchContext + viewOptions used by isLayerVisibleInView
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, visibleLayers, state.activeDiscipline, state.showArchContext, state.viewOptions, doc, documentVersion, currentLevel]);
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
  const project = useEditorState().project;
  const mepSystems = project?.mepSystems;
  const types = project?.types;

  // Keyed on content, so a new floors array with the same elevations keeps
  // every floor's geometry context (and its batch) intact.
  const elevationsKey = allFloors.map(f => `${f.levelId}:${f.elevation}`).join('|');
  const levelElevations = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of allFloors) map.set(f.levelId, f.elevation);
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elevationsKey]);

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
              mepSystems={mepSystems}
              types={types}
            />
          </group>
        );
      })}
    </group>
  );
}

const RenderElements = memo(function RenderElements({ elements, levelId, levelElevation, levelElevations, mepSystems, types, ghost }: {
  elements: CanonicalElement[];
  levelId: string;
  levelElevation: number;
  levelElevations: Map<string, number>;
  mepSystems?: import('../types.ts').SystemDef[];
  types?: import('../model/types/catalog.ts').TypeCatalog;
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
    return buildGeometryContext({ level, allLevels, allElements, mepSystems, types });
  }, [levelId, levelElevation, levelElevations, allElements, mepSystems, types]);

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

  // Element meshes are rendered into a detached group (never in the scene)
  // and merged into one mesh per material once committed, and again whenever
  // they change. The portal commits before this layout effect runs, so the
  // R3F objects are in place.
  const source = useMemo(() => new Group(), []);
  const batchRef = useRef<Group>(null);
  useLayoutEffect(() => {
    const root = batchRef.current;
    if (!root) return;
    const batch = buildStaticBatch(source);
    for (const o of batch.objects) root.add(o);
    return () => releaseStaticBatch(batch);
  }, [source, v2Elements, v2Ctx]);

  return (
    <>
      {createPortal(
        v2Elements.map(el => <ElementNode3D key={el.id} element={el} ctx={v2Ctx} />),
        source,
      )}
      <group ref={batchRef} />
      <FloorHighlights elements={v2Elements} ctx={v2Ctx} />
      {meshElements.length > 0 && (
        <Suspense fallback={null}>
          <MeshInstances elements={meshElements} tableName="__mesh__"
            levelElevation={levelElevation} levelElevations={levelElevations} ghost={ghost} />
        </Suspense>
      )}
    </>
  );
});

/** Selected / hovered elements of one floor, drawn over the batched meshes. */
function FloorHighlights({ elements, ctx }: { elements: CanonicalElement[]; ctx: GeometryContext }) {
  const { selectedIds, hoveredId } = useSelectionState();
  const byId = useMemo(() => new Map(elements.map(el => [el.id, el])), [elements]);
  const ids: string[] = [];
  for (const id of selectedIds) if (byId.has(id)) ids.push(id);
  if (hoveredId && !selectedIds.has(hoveredId) && byId.has(hoveredId)) ids.push(hoveredId);
  if (ids.length === 0) return null;
  return (
    <group>
      {ids.map(id => (
        <ElementHighlight3D key={id} element={byId.get(id)!} ctx={ctx}
          selected={selectedIds.has(id)} hovered={hoveredId === id} />
      ))}
    </group>
  );
}
