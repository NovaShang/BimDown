/**
 * Load a project's MEP network (curves, hosts, ports, circuits) in world
 * coordinates for the connectivity check and the system summary.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv } from '../utils/csv.js';
import { parseGeoJsonFile, extractLineGeometry, extractPointGeometry, type BimDownFeature } from '../utils/geojson.js';
import { discoverLayout, listFiles } from '../utils/fs.js';
import type { MepModelIn, MepCurveIn, MepHostIn, MepPortIn, MepCircuitIn, Vec3 } from './check.js';

export const MEP_CURVE_TABLES = ['duct', 'pipe', 'cable_tray', 'conduit'];
const HOST_TABLES = ['equipment', 'terminal', 'mep_node'] as const;

export interface LoadedMep extends MepModelIn {
  /** Raw CSV rows by `${dir}/${id}` (curves and hosts). */
  rowOf: Map<string, Record<string, string>>;
}

function num(v: unknown, fallback = 0): number {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

function levelElevations(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const p = join(dir, 'global', 'level.csv');
  if (!existsSync(p)) return out;
  for (const r of readCsv(p).rows) out.set(r.id, num(r.elevation));
  return out;
}

function featuresById(path: string): Map<string, BimDownFeature> {
  const map = new Map<string, BimDownFeature>();
  if (!existsSync(path)) return map;
  try {
    for (const f of parseGeoJsonFile(path).features) {
      const id = String(f.properties?.id ?? '');
      if (id) map.set(id, f);
    }
  } catch { /* unreadable geometry: validate reports it */ }
  return map;
}

export function loadMep(dir: string): LoadedMep {
  const layout = discoverLayout(dir);
  const elev = levelElevations(dir);
  const dirs = [{ name: 'global', path: layout.globalDir }, ...layout.levelDirs];
  const curves: MepCurveIn[] = [];
  const hosts: MepHostIn[] = [];
  const ports: MepPortIn[] = [];
  const circuits: MepCircuitIn[] = [];
  const rowOf = new Map<string, Record<string, string>>();
  const hostFrame = new Map<string, { pos: Vec3; rot: number }>(); // `${dir}/${id}`
  const connectorRows: (Record<string, string> & { __dir: string })[] = [];

  for (const d of dirs) {
    if (!existsSync(d.path)) continue;
    const files = new Set(listFiles(d.path));
    const base = elev.get(d.name) ?? 0;
    for (const t of MEP_CURVE_TABLES) {
      if (!files.has(`${t}.csv`)) continue;
      const geo = featuresById(join(d.path, `${t}.geojson`));
      for (const row of readCsv(join(d.path, `${t}.csv`)).rows) {
        const f = geo.get(row.id);
        if (!f || f.geometry.type !== 'LineString') continue;
        let lg;
        try { lg = extractLineGeometry(f); } catch { continue; }
        const off = num(f.properties?.base_offset);
        curves.push({
          id: row.id, scope: d.name, table: t,
          a: [lg.start_x, lg.start_y, lg.start_z ?? base + off],
          b: [lg.end_x, lg.end_y, lg.end_z ?? base + off],
          from: row.from ?? '', to: row.to ?? '', system: (row.system_type ?? '').trim(),
        });
        rowOf.set(`${d.name}/${row.id}`, row);
      }
    }
    for (const t of HOST_TABLES) {
      if (!files.has(`${t}.csv`)) continue;
      const geo = featuresById(join(d.path, `${t}.geojson`));
      for (const row of readCsv(join(d.path, `${t}.csv`)).rows) {
        const f = geo.get(row.id);
        if (!f || f.geometry.type !== 'Point') continue;
        const pg = extractPointGeometry(f);
        const pos: Vec3 = [pg.x, pg.y, pg.z ?? base + num(f.properties?.base_offset)];
        hosts.push({
          id: row.id, scope: d.name, table: t, pos,
          kind: (row.kind ?? '').trim(), fitting: (row.fitting ?? '').trim(),
          system: (row.system_type ?? '').trim(), circuitId: (row.circuit_id ?? '').trim(), load: num(row.load),
        });
        hostFrame.set(`${d.name}/${row.id}`, { pos, rot: pg.rotation ?? 0 });
        rowOf.set(`${d.name}/${row.id}`, row);
      }
    }
    if (files.has('connector.csv')) for (const r of readCsv(join(d.path, 'connector.csv')).rows) connectorRows.push({ ...r, __dir: d.name });
    if (files.has('circuit.csv')) {
      for (const r of readCsv(join(d.path, 'circuit.csv')).rows) {
        circuits.push({ id: r.id, scope: d.name, hostId: r.host_id ?? '', number: r.number ?? '', voltage: num(r.voltage), rating: num(r.rating) });
      }
    }
  }

  for (const r of connectorRows) {
    const host = hostFrame.get(`${r.__dir}/${r.host_id ?? ''}`) ?? hostFrame.get(`global/${r.host_id ?? ''}`);
    if (!host || !r.name) continue;
    const th = (host.rot * Math.PI) / 180;
    const ox = num(r.offset_x), oy = num(r.offset_y), oz = num(r.offset_z);
    ports.push({
      hostId: r.host_id, scope: hostFrame.has(`${r.__dir}/${r.host_id}`) ? r.__dir : 'global', name: r.name,
      pos: [host.pos[0] + ox * Math.cos(th) - oy * Math.sin(th), host.pos[1] + ox * Math.sin(th) + oy * Math.cos(th), host.pos[2] + oz],
      system: (r.system_type ?? '').trim(), domain: (r.domain ?? '').trim(),
    });
  }

  return { curves, hosts, ports, circuits, rowOf };
}

export interface SystemSummary {
  system: string;
  curves: number;
  length: number;
  devices: number;
  tables: string[];
}

/** Per system_type: curve count, total length, devices (equipment / terminals). */
export function summarizeSystems(m: MepModelIn): SystemSummary[] {
  const by = new Map<string, SystemSummary>();
  const get = (s: string) => {
    let e = by.get(s);
    if (!e) by.set(s, e = { system: s, curves: 0, length: 0, devices: 0, tables: [] });
    return e;
  };
  for (const c of m.curves) {
    const e = get(c.system || '(none)');
    e.curves++;
    e.length += Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
    if (!e.tables.includes(c.table)) e.tables.push(c.table);
  }
  for (const h of m.hosts) {
    if (h.table === 'mep_node') continue;
    for (const s of (h.system || '').split(',').map(x => x.trim()).filter(Boolean)) get(s).devices++;
  }
  return [...by.values()].sort((a, b) => a.system.localeCompare(b.system));
}
