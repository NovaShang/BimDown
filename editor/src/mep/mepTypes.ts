/**
 * MEP type names: how instances group into types for schedules and IFC
 * type objects (IfcPumpType, IfcDuctSegmentType, IfcValveType …). Same
 * name = same type. The IFC exporter pairs the name with the entity /
 * PredefinedType it already picks per instance.
 *
 * - equipment / terminal: "<family>: <type>" (Revit-like), else the enum
 * - accessory (mep_node with kind): "<Kind> <size>", e.g. "Gate Valve DN65"
 * - passive fitting: "<Table> <kind> <size>", e.g. "Duct Elbow 400×300"
 * - run: "<Table> <size>[ <material>][ flexible]", e.g. "Pipe DN65 Steel"
 */
import type { CanonicalElement } from '../model/elements.ts';
import { formatMepSize } from './sizes.ts';
import { isMepLineTable } from '../model/mepTopology.ts';

const TABLE_NAME: Record<string, string> = { duct: 'Duct', pipe: 'Pipe', conduit: 'Conduit', cable_tray: 'Cable Tray' };

const title = (s: string) => s.split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/**
 * Type name of an MEP element (null for non-MEP rows). `fittingKind` is the
 * derived kind of a passive fitting (mep/fittings.ts) and its run table.
 */
export function mepTypeName(
  el: CanonicalElement,
  fitting?: { kind: string; table: string; sizeX: number; sizeY: number; shape: string },
  /** Project units per metre (sizes are stored in project units). */
  unitsPerMetre = 1,
): string | null {
  const a = el.attrs;
  const num = (v: string | undefined) => (parseFloat(v ?? '') || 0) / unitsPerMetre;
  if (el.tableName === 'equipment' || el.tableName === 'terminal') {
    const fam = (a.family ?? '').trim(), typ = (a.type ?? '').trim();
    if (fam || typ) return [fam, typ].filter(Boolean).join(': ');
    return title(a.equipment_type || a.terminal_type || el.tableName);
  }
  if (el.tableName === 'mep_node') {
    const kind = (a.kind ?? '').trim();
    if (kind) {
      const shape = a.shape || (num(a.size_h) > 0 ? 'rect' : 'round');
      const table = kind.includes('damper') ? 'duct' : 'pipe';
      const size = formatMepSize(table, shape, num(a.size_w), num(a.size_h));
      return [title(kind), size].filter(Boolean).join(' ');
    }
    if (!fitting) return null;
    const size = formatMepSize(fitting.table, fitting.shape, fitting.sizeX / unitsPerMetre, fitting.sizeY / unitsPerMetre);
    return [TABLE_NAME[fitting.table] ?? title(fitting.table), title(fitting.kind), size].filter(Boolean).join(' ');
  }
  if (isMepLineTable(el.tableName)) {
    const shape = a.shape || (el.tableName === 'duct' || el.tableName === 'cable_tray' ? 'rect' : 'round');
    const size = formatMepSize(el.tableName, shape, num(a.size_x), num(a.size_y), { material: a.material });
    const parts = [TABLE_NAME[el.tableName], size];
    if (a.material) parts.push(title(a.material));
    if ((a.flexible ?? '').toLowerCase() === 'true') parts.push('Flexible');
    return parts.filter(Boolean).join(' ');
  }
  return null;
}
