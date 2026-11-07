/**
 * Furniture — built-in parametric component library (furniture, casework,
 * appliances without ports, toilet partitions, cars, planting, people,
 * generic placeholders). Point archetype; the family / variant / size_x /
 * size_y / height / mirror attrs drive a plan symbol and a merged low-poly
 * 3D mesh from library/furnitureLibrary.generated.ts (shared with the CLI).
 *
 * Local frame: +Y is the back (against the wall), rotation is CCW degrees.
 */
import type { ReactNode } from 'react';
import type { ElementModule, GeometryContext, SelectionHandle } from './archetypes.ts';
import { registerElement } from './registry.ts';
import type { CanonicalElement, PointElement, Point } from '../model/elements.ts';
import { BASE_OFFSET_FIELD } from './_options.ts';
import { resolvePropertyFields, type PropertyField } from './_propertyFields.ts';
import type { DrawingField } from '../model/tableRegistry.ts';
import {
  defaultSize, furnitureFamilies, furniturePlan, getFurnitureFamily, resolveFurniture,
  type PlanPrim, type ResolvedFurniture,
} from '../library/furnitureLibrary.generated.ts';
import { renderPrims } from '../library/FurnitureSymbol.tsx';
import { metre } from '../annotation/geometry.ts';
import { furnitureGeometry, furnitureMaterial } from '../library/furniture3D.ts';
import { placeFurnitureTool } from '../library/placeFurniture.ts';
import { FurniturePlacementPreview } from '../library/PlacementPreview.tsx';

export interface FurnitureFacts {
  id: string;
  position: Point;
  rotationDeg: number;
  baseY: number;
  resolved: ResolvedFurniture;
  prims: PlanPrim[];
}

const STROKE = '#5b6470';
const STROKE_SELECTED = '#3a7bff';
const STROKE_HOVER = '#06b6d4';

/** Localized label picker: library entries carry en + zh names. */
const pick = (o: { en: string; zh: string }, lang: string) => (lang.startsWith('zh') ? o.zh : o.en);

export function familyOptions(lang: string) {
  return furnitureFamilies().map(f => ({ value: f.id, label: pick(f, lang) }));
}

export function variantOptions(attrs: Record<string, string>, lang: string) {
  const fam = getFurnitureFamily(attrs.family);
  return (fam?.variants ?? []).map(v => ({ value: v.id, label: pick(v, lang) }));
}

const MIRROR_OPTIONS = [{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }];

const num = (v: string | undefined) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : undefined;
};
const same = (a: number | undefined, b: number) => a === undefined || Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));

/**
 * When the family or variant changes, sizes (and the mount height) that were
 * still at the old default follow the new default; edited values are kept.
 */
export function furnitureAttrRules(prev: Record<string, string>, changes: Record<string, string>, upm = metre()): Record<string, string> {
  if (!('family' in changes) && !('variant' in changes)) return {};
  const out: Record<string, string> = {};
  const oldFam = getFurnitureFamily(prev.family);
  const newFam = getFurnitureFamily(changes.family ?? prev.family);
  if (!newFam) return out;
  let variant = changes.variant ?? prev.variant ?? '';
  if ('family' in changes && changes.family !== prev.family && !(newFam.variants ?? []).some(v => v.id === variant)) {
    variant = newFam.variants?.[0]?.id ?? '';
    out.variant = variant;
  }
  const oldSize = oldFam ? defaultSize(oldFam, prev.variant).map(v => v * upm) : undefined;
  const newSize = defaultSize(newFam, variant).map(v => v * upm);
  (['size_x', 'size_y', 'height'] as const).forEach((k, i) => {
    if (k in changes) return;
    const cur = num(prev[k]);
    if (!oldSize || cur === undefined || same(cur, oldSize[i])) out[k] = String(newSize[i]);
  });
  if (!('base_offset' in changes)) {
    const cur = num(prev.base_offset) ?? 0;
    if (same(cur, (oldFam?.baseOffset ?? 0) * upm)) out.base_offset = String((newFam.baseOffset ?? 0) * upm);
  }
  return out;
}

/** Initial attrs for placing a family (sizes and mount height from the library). */
export function furniturePlacementAttrs(familyId: string, variant?: string, upm = metre()): Record<string, string> {
  const fam = getFurnitureFamily(familyId);
  if (!fam) return { family: familyId };
  const v = variant ?? fam.variants?.[0]?.id ?? '';
  const [w, d, h] = defaultSize(fam, v).map(x => x * upm);
  return {
    family: fam.id, variant: v,
    size_x: String(w), size_y: String(d), height: String(h),
    base_offset: String((fam.baseOffset ?? 0) * upm), mirror: 'false',
  };
}

/** Local → world for an element pose. */
function toWorld(o: Point, rotDeg: number, lx: number, ly: number): Point {
  const a = (rotDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: o.x + lx * c - ly * s, y: o.y + lx * s + ly * c };
}

function sizeHandles(facts: FurnitureFacts): SelectionHandle[] {
  const { w, d } = facts.resolved.size;
  const k = facts.resolved.upm; // sizes snap to 1 cm, at least 10 cm
  const snapSize = (v: number) => Math.max(0.1 * k, Math.round(v / (0.01 * k)) * 0.01 * k);
  const rot = facts.rotationDeg;
  const a = (rot * Math.PI) / 180;
  const ux = { x: Math.cos(a), y: Math.sin(a) };   // local +X in world
  const uy = { x: -Math.sin(a), y: Math.cos(a) };  // local +Y (back) in world
  return [
    {
      // Right edge: width grows to the right, left edge stays.
      id: 'width', cursor: 'ew-resize',
      position: toWorld(facts.position, rot, w / 2, 0),
      onDrag(snapped, _start, snapshot) {
        const p = snapshot as PointElement;
        const sw = num(p.attrs.size_x) ?? w;
        const left = { x: p.position.x - ux.x * sw / 2, y: p.position.y - ux.y * sw / 2 };
        const nw = snapSize((snapped.x - left.x) * ux.x + (snapped.y - left.y) * ux.y);
        return {
          position: { x: left.x + ux.x * nw / 2, y: left.y + ux.y * nw / 2 },
          width: nw,
          attrs: { ...p.attrs, size_x: String(nw) },
        } as Partial<CanonicalElement>;
      },
    },
    {
      // Front edge: depth grows towards the front, the back stays on the wall.
      id: 'depth', cursor: 'ns-resize',
      position: toWorld(facts.position, rot, 0, -d / 2),
      onDrag(snapped, _start, snapshot) {
        const p = snapshot as PointElement;
        const sd = num(p.attrs.size_y) ?? d;
        const back = { x: p.position.x + uy.x * sd / 2, y: p.position.y + uy.y * sd / 2 };
        const nd = snapSize((back.x - snapped.x) * uy.x + (back.y - snapped.y) * uy.y);
        return {
          position: { x: back.x - uy.x * nd / 2, y: back.y - uy.y * nd / 2 },
          height: nd,
          attrs: { ...p.attrs, size_y: String(nd) },
        } as Partial<CanonicalElement>;
      },
    },
  ];
}

const CSV_HEADERS = ['number', 'family', 'variant', 'size_x', 'size_y', 'height', 'rotation', 'mirror', 'base_offset'];
const DRAWING_FIELDS: DrawingField[] = [
  // Library names are data (en + zh), localized by optionsFor rather than option.* keys.
  { key: 'family', label: 'Family', type: 'select', options: [], optionsFor: (_a, lang) => familyOptions(lang) },
  { key: 'variant', label: 'Variant', type: 'select', options: [], optionsFor: variantOptions },
  { key: 'size_x', label: 'Width', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
  { key: 'size_y', label: 'Depth', type: 'number', unit: 'm', min: 0.05, step: 0.05 },
  { key: 'height', label: 'Height', type: 'number', unit: 'm', min: 0.01, step: 0.05 },
  { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', step: 90 },
  { key: 'mirror', label: 'Mirror', type: 'select', options: MIRROR_OPTIONS },
  BASE_OFFSET_FIELD,
];
// Family / variant read as identity, rotation as geometry (the global
// defaults file them under relationships / mesh).
const PROPERTY_FIELDS: PropertyField[] = resolvePropertyFields(CSV_HEADERS, DRAWING_FIELDS).map(f =>
  f.key === 'family' || f.key === 'variant' ? { ...f, type: 'select', group: 'identity' }
    : f.key === 'rotation' ? { ...f, group: 'geometry' }
      : f);

export const furnitureModule: ElementModule<FurnitureFacts> = {
  table: 'furniture',
  discipline: 'architecture',
  archetype: 'point',
  prefix: 'fu',
  csvHeaders: CSV_HEADERS,
  defaults: {
    number: '', family: 'generic_box', variant: '', size_x: '1', size_y: '1', height: '1',
    rotation: '0', mirror: 'false', base_offset: '0',
  },
  drawingFields: DRAWING_FIELDS,
  propertyFields: PROPERTY_FIELDS,
  layerStyle: { displayName: 'Furniture', color: '#8d6e63', icon: '▣', order: 9 },
  // The library panel places furniture; no plain toolbar slot.
  hiddenFromToolbar: true,
  renderZIndex: 35,
  placeTool: placeFurnitureTool,
  placementPreview: FurniturePlacementPreview,
  attrChangeRules: furnitureAttrRules,

  geometry(el: CanonicalElement, ctx: GeometryContext): FurnitureFacts | null {
    if (el.geometry !== 'point') return null;
    const p = el as PointElement;
    const resolved = resolveFurniture(p.attrs, ctx.unitsPerMetre);
    return {
      id: p.id,
      position: p.position,
      rotationDeg: parseFloat(p.attrs.rotation || '0') || 0,
      baseY: ctx.levelElevation + (parseFloat(p.attrs.base_offset || '0') || 0),
      resolved,
      prims: furniturePlan(resolved),
    };
  },

  draw2D(facts, ctx): ReactNode {
    const { w, d } = facts.resolved.size;
    const k = facts.resolved.upm;
    const stroke = ctx.selected ? STROKE_SELECTED : ctx.hovered ? STROKE_HOVER : STROKE;
    return (
      <g data-id={facts.id}
        transform={`translate(${facts.position.x},${facts.position.y}) rotate(${facts.rotationDeg})`}>
        {/* Pick area: line-only symbols (partitions, parking) stay clickable. */}
        <rect x={-w / 2} y={-d / 2} width={w} height={d} fill="none" pointerEvents="all" />
        {renderPrims(facts.prims, { stroke, width: (ctx.selected ? 0.02 : 0.012) * k, dash: `${0.06 * k} ${0.04 * k}` })}
      </g>
    );
  },

  draw3D(facts, drawCtx): ReactNode {
    const isHL = drawCtx.selected || drawCtx.hovered;
    const geometry = furnitureGeometry(facts.resolved);
    return (
      <mesh
        geometry={geometry}
        position={[facts.position.x, facts.baseY, -facts.position.y]}
        rotation={[0, (facts.rotationDeg * Math.PI) / 180, 0]}
        material={isHL ? undefined : furnitureMaterial()}
        castShadow
        receiveShadow
        userData={{ elementId: facts.id }}
      >
        {isHL && <meshStandardMaterial attach="material" color="#06b6d4" />}
      </mesh>
    );
  },

  bbox(facts) {
    const { w, d } = facts.resolved.size;
    const a = (facts.rotationDeg * Math.PI) / 180;
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const bw = w * c + d * s, bh = w * s + d * c;
    return { x: facts.position.x - bw / 2, y: facts.position.y - bh / 2, w: bw, h: bh };
  },

  hitZones(facts) {
    const { w, d } = facts.resolved.size;
    const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
    return [{ kind: 'polygon', points: corners.map(([x, y]) => toWorld(facts.position, facts.rotationDeg, x, y)) }];
  },

  selectionHandles(facts) {
    return sizeHandles(facts);
  },
};

registerElement(furnitureModule);
