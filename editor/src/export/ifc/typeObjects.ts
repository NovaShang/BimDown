/**
 * IFC type objects (IfcColumnType, IfcWallType, IfcDoorStyle / IfcDoorType,
 * IfcPumpType …): which type an exported product gets, and its name.
 *
 * A typed element (type_id) shares its BimDown type; an untyped one is grouped
 * with the elements of the same signature (section, kind and size, thickness,
 * family …), so every product has a type and equal ones share it, as in a
 * Revit export. Schema-neutral: the writer picks the entity per schema.
 */
import { mepTypeName } from '../../mep/mepTypes.ts';
import type { CanonicalElement } from '../../model/elements.ts';
import { typeOfElement, type TypeCatalog } from '../../model/types/catalog.ts';

export interface TypeSig {
  /** Grouping key (one IFC type per key and type entity). */
  key: string;
  /** Type name: the BimDown type's, else a descriptive one ("Concrete 300x600"). */
  name: string;
  description?: string;
  /** BimDown type id, when the element is typed. */
  typeId?: string;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : s);

/** Size in mm (project units → metres → mm), '' when blank. */
function mm(v: string | undefined, upm: number): string {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) && n > 0 ? String(Math.round((n / upm) * 10000) / 10) : '';
}

const join = (...parts: string[]) => parts.filter(Boolean).join('x');

/** Type signature of an exported element, or null for tables without IFC types. */
export function elementTypeSig(el: CanonicalElement, catalog: TypeCatalog | undefined, upm = 1): TypeSig | null {
  const t = typeOfElement(el, catalog);
  if (t) return { key: `type:${t.id}`, name: t.name, description: t.description || undefined, typeId: t.id };
  const a = el.attrs;
  const mat = cap(a.material || '');
  const k = (...parts: (string | undefined)[]) => `${el.tableName}:${parts.map(p => p ?? '').join(':')}`;
  switch (el.tableName) {
    case 'column': case 'structure_column': case 'beam': case 'brace': {
      const shape = a.shape || 'rect';
      const dims = shape === 'round' || shape === 'round_hollow'
        ? `Ø${join(mm(a.size_x, upm), shape === 'round_hollow' ? mm(a.thickness, upm) : '')}`
        : join(mm(a.size_x, upm), mm(a.size_y, upm));
      const name = a.designation || [mat, shape === 'rect' || shape === 'round' ? '' : cap(shape), dims].filter(Boolean).join(' ');
      return { key: k(shape, a.size_x, a.size_y, a.flange, a.web, a.thickness, a.root_radius, a.designation, a.material), name };
    }
    case 'foundation': {
      const kind = a.kind || (el.geometry === 'point' ? 'pad' : el.geometry === 'polygon' ? 'raft' : 'strip');
      const dims = kind === 'pile'
        ? `Ø${mm(a.width, upm)} L${mm(a.thickness, upm)}`
        : el.geometry === 'point' ? join(mm(a.width, upm), mm(a.length || a.width, upm), mm(a.thickness, upm))
        : el.geometry === 'line' ? join(mm(a.width, upm), mm(a.thickness, upm)) : mm(a.thickness, upm);
      return { key: k(kind, a.width, a.length, a.thickness, a.material), name: `${cap(kind)} ${dims}`.trim() };
    }
    case 'wall': case 'structure_wall': case 'slab': case 'structure_slab': case 'roof': case 'ceiling':
      return { key: k(a.material, a.thickness, a.function), name: [mat || cap(el.tableName), mm(a.thickness, upm)].filter(Boolean).join(' ') };
    case 'door': case 'window':
      return {
        key: k(a.operation, a.width, a.height, a.material),
        name: [cap(a.operation || (el.tableName === 'door' ? 'single_swing' : 'fixed')), join(mm(a.width, upm), mm(a.height, upm))].filter(Boolean).join(' '),
      };
    case 'curtain_wall':
      return { key: k(a.u_spacing, a.v_spacing, a.mullion_width), name: `Curtain wall ${join(mm(a.u_spacing, upm), mm(a.v_spacing, upm))}`.trim() };
    case 'railing':
      return { key: k(a.height, a.material), name: `Railing ${mm(a.height, upm)}`.trim() };
    case 'furniture':
      return { key: k(a.family, a.variant), name: [cap(a.family || 'furniture'), a.variant].filter(Boolean).join(' · ') };
    // MEP: the names schedules use (mep/mepTypes.ts): "Pipe DN50 Copper", "AHU: 5000 m³/h", "Gate valve DN80" …
    case 'duct': case 'pipe': case 'cable_tray': case 'conduit': {
      const round = a.shape === 'round' || el.tableName === 'pipe' || el.tableName === 'conduit';
      const size = round ? `Ø${mm(a.size_x, upm)}` : join(mm(a.size_x, upm), mm(a.size_y, upm));
      return { key: k(a.shape, a.size_x, round ? '' : a.size_y, a.flexible, a.material), name: mepTypeName(el, undefined, upm) ?? `${cap(el.tableName)} ${size}`.trim() };
    }
    case 'equipment':
      return { key: k(a.equipment_type, a.family, a.type), name: mepTypeName(el, undefined, upm) ?? cap(a.equipment_type || 'equipment') };
    case 'terminal':
      return { key: k(a.terminal_type, a.family, a.type), name: mepTypeName(el, undefined, upm) ?? cap(a.terminal_type || 'terminal') };
    case 'mep_node': {
      const kind = a.kind || a.fitting || 'fitting';
      // A passive fitting's type is its kind (elbow, tee …) and family, as Revit's fitting
      // families: the size is the instance's. An imported one keeps its family / type name.
      const family = [a.family, a.type].filter(Boolean).join(': ');
      if (!a.kind) return { key: family ? k(kind, a.family, a.type) : k(kind, a.shape), name: family || `${cap(kind)}${a.shape ? ` (${a.shape})` : ''}` };
      const size = join(mm(a.size_w, upm), mm(a.size_h, upm));
      return { key: k(kind, a.size_w, a.size_h, a.shape, a.family, a.type), name: family ? `${family} ${size}`.trim() : mepTypeName(el, undefined, upm) ?? `${cap(kind)} ${size}`.trim() };
    }
  }
  return null;
}

/** IFC2X3 type entity per building-element product entity (no IfcFootingType / IfcPileType there). */
const TYPE_2X3: Record<string, string> = {
  IfcColumn: 'IfcColumnType', IfcBeam: 'IfcBeamType', IfcMember: 'IfcMemberType',
  IfcWall: 'IfcWallType', IfcWallStandardCase: 'IfcWallType', IfcSlab: 'IfcSlabType', IfcCovering: 'IfcCoveringType',
  IfcCurtainWall: 'IfcCurtainWallType', IfcRailing: 'IfcRailingType', IfcDoor: 'IfcDoorStyle', IfcWindow: 'IfcWindowStyle',
  IfcFurnishingElement: 'IfcFurnitureType', IfcFooting: 'IfcBuildingElementProxyType', IfcPile: 'IfcBuildingElementProxyType',
  IfcBuildingElementProxy: 'IfcBuildingElementProxyType',
};

/** Abstract (or generic) IFC4 entities whose `…Type` must not be instantiated. */
const GENERIC = new Set([
  'IfcFlowTerminal', 'IfcFlowFitting', 'IfcFlowSegment', 'IfcFlowController', 'IfcFlowMovingDevice', 'IfcFlowStorageDevice',
  'IfcFlowTreatmentDevice', 'IfcEnergyConversionDevice', 'IfcDistributionControlElement', 'IfcDistributionElement',
]);

/**
 * Type entity of a product: the IFC4 `<entity>Type` (MEP: the IFC4 entity's
 * type, which IFC2X3 shares by name), the IFC2X3 equivalent, or null.
 */
export function typeEntityFor(entity: string, ifc4: boolean, has: (e: string) => boolean, mepEntity4?: string): string | null {
  if (mepEntity4) {
    const t = `${mepEntity4}Type`;
    return !GENERIC.has(mepEntity4) && has(t) ? t : null;
  }
  if (ifc4) {
    const t = `${entity}Type`;
    return !GENERIC.has(entity) && has(t) ? t : null;
  }
  const t = TYPE_2X3[entity];
  return t && has(t) ? t : null;
}

/** IfcPileTypeEnum (IFC4) / IfcPileConstructionEnum (IFC2X3) from the pile's material. */
export function pileKind(material: string): { predefined4: string; construction: string } {
  if (material === 'steel') return { predefined4: 'DRIVEN', construction: 'PREFAB_STEEL' };
  if (material === 'wood') return { predefined4: 'DRIVEN', construction: 'USERDEFINED' };
  return { predefined4: 'BORED', construction: 'CAST_IN_PLACE' };
}
