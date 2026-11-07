/**
 * Editor document → connectivity-check model (mepCheck.ts) and a system
 * summary for the system browser. Coordinates stay level-relative.
 */
import type { CanonicalElement, LineElement, SpatialLineElement, PointElement } from '../model/elements.ts';
import { isMepLineTable } from '../model/mepTopology.ts';
import { endZ } from '../model/mepSplit.ts';
import { checkMep, type MepModelIn, type MepProblem, type Vec3 } from './mepCheck.ts';
import { inSystem } from './mepView.ts';
import type { LayerData, ProjectData } from '../types.ts';
import { crossLevelRefs } from './externalRefs.ts';

type MepCurve = LineElement | SpatialLineElement;

const num = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d; };

/** What the other levels (and global/) contribute: refs their runs make and the hosts they hold. */
export interface ExternalMep { refs: string[]; hosts: string[] }

const HOST_TABLES = new Set(['equipment', 'terminal', 'mep_node']);

export function externalMep(project: ProjectData | null, currentLevel: string): ExternalMep {
  const refs: string[] = [];
  const hosts: string[] = [];
  const scan = (layers: readonly LayerData[]) => {
    refs.push(...crossLevelRefs(layers));
    for (const layer of layers) {
      if (HOST_TABLES.has(layer.tableName)) for (const id of layer.csvRows.keys()) hosts.push(id);
    }
  };
  if (project) {
    for (const [levelId, floor] of project.floors) if (levelId !== currentLevel) scan(floor.layers);
    scan(project.globalLayers);
  }
  return { refs, hosts };
}

export function buildMepModel(elements: ReadonlyMap<string, CanonicalElement>, ext?: ExternalMep): MepModelIn {
  const m: MepModelIn = { curves: [], hosts: [], ports: [], circuits: [], complete: false, externalRefs: ext?.refs, externalHosts: ext?.hosts };
  const hosts = new Map<string, PointElement>();
  for (const el of elements.values()) {
    if (isMepLineTable(el.tableName) && (el.geometry === 'line' || el.geometry === 'spatial_line')) {
      const c = el as MepCurve;
      m.curves.push({
        id: c.id, table: c.tableName,
        a: [c.start.x, c.start.y, endZ(c, 'start')], b: [c.end.x, c.end.y, endZ(c, 'end')],
        from: c.attrs.from ?? '', to: c.attrs.to ?? '', system: (c.attrs.system_type ?? '').trim(),
      });
    } else if ((el.tableName === 'equipment' || el.tableName === 'terminal' || el.tableName === 'mep_node') && el.geometry === 'point') {
      const p = el as PointElement;
      hosts.set(p.id, p);
      m.hosts.push({
        id: p.id, table: el.tableName, pos: [p.position.x, p.position.y, num(p.attrs.base_offset)],
        kind: (p.attrs.kind ?? '').trim(), fitting: (p.attrs.fitting ?? '').trim(),
        system: (p.attrs.system_type ?? '').trim(), circuitId: (p.attrs.circuit_id ?? '').trim(), load: num(p.attrs.load),
      });
    } else if (el.tableName === 'circuit') {
      m.circuits!.push({ id: el.id, hostId: el.hostId || el.attrs.host_id || '', number: el.attrs.number || '', voltage: num(el.attrs.voltage), rating: num(el.attrs.rating) });
    }
  }
  for (const el of elements.values()) {
    if (el.tableName !== 'connector') continue;
    const hostId = el.hostId || el.attrs.host_id || '';
    const host = hosts.get(hostId);
    if (!host || !el.attrs.name) continue;
    const rot = (num(host.attrs.rotation) * Math.PI) / 180;
    const ox = num(el.attrs.offset_x), oy = num(el.attrs.offset_y), oz = num(el.attrs.offset_z);
    const pos: Vec3 = [
      host.position.x + ox * Math.cos(rot) - oy * Math.sin(rot),
      host.position.y + ox * Math.sin(rot) + oy * Math.cos(rot),
      num(host.attrs.base_offset) + oz,
    ];
    m.ports.push({ hostId, name: el.attrs.name, pos, system: (el.attrs.system_type ?? '').trim(), domain: (el.attrs.domain ?? '').trim() });
  }
  return m;
}

export function checkDocument(elements: ReadonlyMap<string, CanonicalElement>, ext?: ExternalMep): MepProblem[] {
  return checkMep(buildMepModel(elements, ext));
}

export interface SystemRow {
  system: string;
  curves: number;
  length: number;
  devices: number;
  ids: string[];
}

/** Members of each system_type on this level (curves, devices, fittings). */
export function systemRows(elements: ReadonlyMap<string, CanonicalElement>): SystemRow[] {
  const by = new Map<string, SystemRow>();
  const row = (s: string) => {
    let r = by.get(s);
    if (!r) by.set(s, r = { system: s, curves: 0, length: 0, devices: 0, ids: [] });
    return r;
  };
  for (const el of elements.values()) {
    const sys = (el.attrs.system_type ?? '').trim();
    if (!sys) continue;
    if (isMepLineTable(el.tableName) && (el.geometry === 'line' || el.geometry === 'spatial_line')) {
      const c = el as MepCurve;
      const r = row(sys);
      r.curves++;
      r.length += Math.hypot(c.end.x - c.start.x, c.end.y - c.start.y, endZ(c, 'end') - endZ(c, 'start'));
      r.ids.push(c.id);
    } else if (el.tableName === 'equipment' || el.tableName === 'terminal' || el.tableName === 'mep_node') {
      for (const s of sys.split(',').map(x => x.trim()).filter(Boolean)) {
        const r = row(s);
        if (el.tableName !== 'mep_node') r.devices++;
        r.ids.push(el.id);
      }
    }
  }
  return [...by.values()].sort((a, b) => a.system.localeCompare(b.system));
}

/** Ids of everything on `system` (for select / isolate). */
export function systemMemberIds(elements: ReadonlyMap<string, CanonicalElement>, system: string): string[] {
  const out: string[] = [];
  for (const el of elements.values()) if (inSystem(el.attrs.system_type, system)) out.push(el.id);
  return out;
}
